import { DurableObject } from "cloudflare:workers";
import {
	createGame,
	createToken,
	discardAndEndTurn,
	drawCard,
	CHAT_QUOTES,
	MAX_BOTS,
	MAX_PLAYERS,
	playBotTurn,
	randomInteger,
	removePlayerFromGame,
	skipRound,
	soloRunScore,
} from "../og_static_files/gameRules.js";

const ROOM_CODE_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 8;
const ROOM_IDLE_MS = 24 * 60 * 60 * 1000;

function recalculateLeaderboardScores(entries){
	const scores = (Array.isArray(entries) ? entries : [])
		.filter(entry => typeof entry?.useTwosWild === "boolean")
		.map(entry => Number.isSafeInteger(entry.turns) && entry.turns >= 0 &&
			Number.isSafeInteger(entry.elapsedSeconds) && entry.elapsedSeconds >= 0
			? { ...entry, score: soloRunScore(entry.turns, entry.elapsedSeconds) }
			: entry)
		.sort((first, second) => second.score - first.score ||
			(first.elapsedSeconds ?? Number.MAX_SAFE_INTEGER) -
				(second.elapsedSeconds ?? Number.MAX_SAFE_INTEGER) ||
			(first.turns ?? Number.MAX_SAFE_INTEGER) -
				(second.turns ?? Number.MAX_SAFE_INTEGER) ||
			(first.submittedAt || "").localeCompare(second.submittedAt || ""));
	return [
		...scores.filter(entry => entry.useTwosWild === false).slice(0, 10),
		...scores.filter(entry => entry.useTwosWild === true).slice(0, 10)
	];
}

function jsonResponse(data, status = 200){
	return Response.json(data, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

async function readJson(request){
	try{
		return await request.json();
	}catch(error){
		if(error instanceof SyntaxError){
			return null;
		}
		throw error;
	}
}

function cleanName(value){
	if(typeof value !== "string"){
		return "";
	}
	return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 20);
}

function createRoomCode(){
	return Array.from(
		{ length: ROOM_CODE_LENGTH },
		() => ROOM_CODE_CHARACTERS[randomInteger(ROOM_CODE_CHARACTERS.length)]
	).join("");
}

function roomStub(env, code){
	const id = env.MY_DURABLE_OBJECT.idFromName("room:" + code);
	return env.MY_DURABLE_OBJECT.get(id);
}

async function routeRoom(request, env, code, action){
	if(!/^[A-Z0-9]{8}$/.test(code)){
		return jsonResponse({ error: "Enter a valid 8-character room code." }, 400);
	}
	if(action === "join"){
		const body = await readJson(request);
		if(!body){
			return jsonResponse({ error: "Send valid JSON to join a room." }, 400);
		}
		const name = cleanName(body.name);
		if(!name){
			return jsonResponse({ error: "Enter a name between 1 and 20 characters." }, 400);
		}
		const stub = roomStub(env, code);
		return stub.fetch("https://room.internal/join", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		});
	}
	if(action === "socket"){
		return roomStub(env, code).fetch(request);
	}
	return jsonResponse({ error: "Not found." }, 404);
}

export default {
	async fetch(request, env){
		const url = new URL(request.url);
		if(url.pathname === "/api/rooms" && request.method === "POST"){
			const body = await readJson(request);
			if(!body){
				return jsonResponse({ error: "Send valid JSON to create a room." }, 400);
			}
			const name = cleanName(body.name);
			if(!name){
				return jsonResponse({ error: "Enter a name between 1 and 20 characters." }, 400);
			}
			for(let attempt = 0; attempt < 3; attempt++){
				const code = createRoomCode();
				const response = await roomStub(env, code).fetch("https://room.internal/create", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ code, name, useTwosWild: body.useTwosWild === true }),
				});
				if(response.status !== 409){
					return response;
				}
			}
			return jsonResponse({ error: "Could not reserve a room code. Please try again." }, 503);
		}

		if(url.pathname === "/api/test/authorize-skip" && request.method === "POST"){
			if(typeof env.ROUND_SKIP_PASSWORD !== "string" || !env.ROUND_SKIP_PASSWORD){
				return jsonResponse({ error: "Round skipping is disabled until the Worker testing secret is configured." }, 503);
			}
			const expectedPassword = env.ROUND_SKIP_PASSWORD.trim();
			const body = await readJson(request);
			if(!body || typeof body.password !== "string" ||
				body.password.trim() !== expectedPassword){
				return jsonResponse({
					error: "The testing password was rejected. Check that the exact ROUND_SKIP_PASSWORD value is entered and restart Wrangler after changing .dev.vars."
				}, 403);
			}
			return jsonResponse({ authorized: true });
		}

		const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{8})\/(join|socket)$/);
		if(roomMatch){
			if(roomMatch[2] === "socket" && request.method === "GET"){
				return routeRoom(request, env, roomMatch[1], "socket");
			}
			if(roomMatch[2] === "join" && request.method === "POST"){
				return routeRoom(request, env, roomMatch[1], "join");
			}
		}

		if(url.pathname === "/api/leaderboard"){
			const leaderboardId = env.MY_DURABLE_OBJECT.idFromName("global:leaderboard");
			const leaderboard = env.MY_DURABLE_OBJECT.get(leaderboardId);
			if(request.method === "GET"){
				return leaderboard.fetch("https://leaderboard.internal/leaderboard");
			}
			if(request.method === "POST"){
				const body = await readJson(request);
				if(!body){
					return jsonResponse({ error: "Send valid JSON with a score." }, 400);
				}
				return leaderboard.fetch("https://leaderboard.internal/leaderboard", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name: cleanName(body.name),
						score: body.score,
						turns: body.turns,
						elapsedSeconds: body.elapsedSeconds,
						useTwosWild: body.useTwosWild
					}),
				});
			}
			return jsonResponse({ error: "Method not allowed." }, 405);
		}

		return new Response("Not found", { status: 404 });
	},
};

export class MyDurableObject extends DurableObject {
	constructor(ctx, env){
		super(ctx, env);
		this.env = env;
		this.room = null;
		this.ctx.blockConcurrencyWhile(async () => {
			this.room = await this.ctx.storage.get("room") || null;
		});
	}

	async fetch(request){
		const url = new URL(request.url);
		if(request.headers.get("Upgrade")?.toLowerCase() === "websocket"){
			return this.connect(request);
		}
		if(url.pathname === "/create" && request.method === "POST"){
			return this.createRoom(request);
		}
		if(url.pathname === "/join" && request.method === "POST"){
			return this.joinRoom(request);
		}
		if(url.pathname === "/leaderboard"){
			return this.leaderboard(request);
		}
		return jsonResponse({ error: "Not found." }, 404);
	}

	async createRoom(request){
		if(this.room){
			return jsonResponse({ error: "That room code is already in use." }, 409);
		}
		const body = await readJson(request);
		if(!body){
			return jsonResponse({ error: "Invalid room request." }, 400);
		}
		const name = cleanName(body.name);
		if(!name || typeof body.code !== "string"){
			return jsonResponse({ error: "Room name and code are required." }, 400);
		}
		const host = { id: createToken(12), token: createToken(), name };
		this.room = {
			code: body.code,
			hostId: host.id,
			status: "waiting",
			useTwosWild: false,
			players: [host],
			bots: [],
			game: null,
			lastActivity: Date.now(),
		};
		await this.persistRoom();
		return jsonResponse({
			code: this.room.code,
			playerId: host.id,
			token: host.token,
			isHost: true,
		}, 201);
	}

	async joinRoom(request){
		if(!this.room){
			return jsonResponse({ error: "Room not found or expired." }, 404);
		}
		if(this.room.status !== "waiting"){
			return jsonResponse({ error: "This room has already started." }, 409);
		}
		if(this.room.players.length + (this.room.bots || []).length >= MAX_PLAYERS){
			return jsonResponse({ error: "This room is full." }, 409);
		}
		const body = await readJson(request);
		if(!body){
			return jsonResponse({ error: "Invalid join request." }, 400);
		}
		const name = cleanName(body.name);
		if(!name){
			return jsonResponse({ error: "Enter a name between 1 and 20 characters." }, 400);
		}
		if(this.room.players.some(player => player.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ||
			(this.room.bots || []).some(bot => bot.name.toLocaleLowerCase() === name.toLocaleLowerCase())){
			return jsonResponse({ error: "That name is already in use in this room." }, 409);
		}
		const player = { id: createToken(12), token: createToken(), name };
		this.room.players.push(player);
		this.room.lastActivity = Date.now();
		await this.persistRoom();
		await this.refreshExpiry();
		this.broadcast();
		return jsonResponse({
			code: this.room.code,
			playerId: player.id,
			token: player.token,
			isHost: false,
		}, 201);
	}

	async connect(request){
		if(!this.room){
			return jsonResponse({ error: "Room not found or expired." }, 404);
		}
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ authenticated: false });
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(socket, message){
		if(typeof message !== "string"){
			this.sendError(socket, "Messages must be JSON text.");
			return;
		}
		let data;
		try{
			data = JSON.parse(message);
		}catch(error){
			if(error instanceof SyntaxError){
				this.sendError(socket, "Send a valid JSON message.");
				return;
			}
			throw error;
		}
		if(!data || typeof data !== "object" || Array.isArray(data)){
			this.sendError(socket, "Send a JSON object with a room action.");
			return;
		}
		const attachment = socket.deserializeAttachment();
		if(!attachment?.authenticated){
			if(data.type !== "authenticate" || typeof data.token !== "string"){
				this.sendError(socket, "Authenticate before sending game actions.");
				socket.close(1008, "Authentication required");
				return;
			}
			const player = this.room?.players.find(item => item.token === data.token);
			if(!player){
				this.sendError(socket, "That room session has expired.");
				socket.close(1008, "Invalid room session");
				return;
			}
			socket.serializeAttachment({ authenticated: true, playerId: player.id });
			this.room.lastActivity = Date.now();
			await this.persistRoom();
			await this.refreshExpiry();
			this.broadcast();
			return;
		}

		const player = this.room?.players.find(item => item.id === attachment.playerId);
		if(!player || !this.room){
			this.sendError(socket, "This room session is no longer active.");
			return;
		}
		try{
			if(data.type === "start"){
				if(player.id !== this.room.hostId || this.room.status !== "waiting"){
					throw new Error("Only the host can start a waiting room.");
				}
				if(this.room.players.length < 2){
					throw new Error("At least two human players are required to start online play.");
				}
				this.room.game = createGame(
					[
						...this.room.players.map(({ id, name }) => ({ id, name })),
						...(this.room.bots || []).map(({ id, name, botSkill }) => ({
							id,
							name,
							isBot: true,
							botSkill
						}))
					],
					this.room.useTwosWild,
					false
				);
				this.room.chat = null;
				this.room.status = "playing";
				this.runBotTurns();
			}else if(data.type === "settings"){
				if(player.id !== this.room.hostId || this.room.status !== "waiting" || this.room.game){
					throw new Error("Only the host can change settings while the room is waiting.");
				}
				if(typeof data.useTwosWild !== "boolean"){
					throw new Error("Choose whether 2s are wild.");
				}
				this.room.useTwosWild = data.useTwosWild;
			}else if(data.type === "bots"){
				if(player.id !== this.room.hostId || this.room.status !== "waiting" || this.room.game){
					throw new Error("Only the host can configure bots while the room is waiting.");
				}
				if(!Array.isArray(data.bots) || data.bots.length > MAX_BOTS ||
					this.room.players.length + data.bots.length > MAX_PLAYERS){
					throw new Error("Add up to three bots, with no more than 20 players total.");
				}
				const names = this.room.players.map(roomPlayer =>
					roomPlayer.name.toLocaleLowerCase()
				);
				const bots = data.bots.map(bot => {
					const name = cleanName(bot?.name);
					const botSkill = bot?.botSkill;
					if(!name || !["easy", "normal", "hard", "extreme"].includes(botSkill)){
						throw new Error("Each bot needs a name and a valid skill level.");
					}
					if(names.includes(name.toLocaleLowerCase())){
						throw new Error("Player and bot names must be unique.");
					}
					names.push(name.toLocaleLowerCase());
					return { id: createToken(12), name, botSkill };
				});
				if(bots.filter(bot => bot.botSkill === "extreme").length > 1){
					throw new Error("Only one bot can have extreme skill.");
				}
				this.room.bots = bots;
			}else if(data.type === "testSkipRound"){
				if(player.id !== this.room.hostId){
					throw new Error("Only the room host can skip a round.");
				}
				if(typeof this.env.ROUND_SKIP_PASSWORD !== "string" ||
					!this.env.ROUND_SKIP_PASSWORD){
					throw new Error("Round skipping is disabled until the Worker testing secret is configured.");
				}
				if(typeof data.password !== "string" ||
					data.password.trim() !== this.env.ROUND_SKIP_PASSWORD.trim()){
					throw new Error("The testing password was rejected. Check the exact ROUND_SKIP_PASSWORD setting.");
				}
				if(this.room.status !== "playing" || !this.room.game){
					throw new Error("Only an active game can skip a round.");
				}
				if(!Number.isInteger(data.targetRound)){
					throw new Error("Choose a destination round.");
				}
				skipRound(this.room.game, data.targetRound);
				if(this.room.game.status === "complete"){
					this.room.status = "complete";
				}else{
					this.runBotTurns();
				}
			}else if(data.type === "kick"){
				if(player.id !== this.room.hostId){
					throw new Error("Only the host can remove a player.");
				}
				const target = this.room.players.find(item => item.id === data.playerId);
				if(!target || target.id === this.room.hostId){
					throw new Error("Choose a player in this room to remove.");
				}
				if(this.room.game?.status === "playing"){
					removePlayerFromGame(this.room.game, target.id);
					if(this.room.game.status === "complete"){
						this.room.status = "complete";
					}else{
						this.runBotTurns();
					}
				}else if(this.room.game){
					const currentPlayerId = this.room.game.players[this.room.game.currentIndex]?.id;
					this.room.game.players = this.room.game.players.filter(item => item.id !== target.id);
					this.room.game.currentIndex = Math.max(
						0,
						this.room.game.players.findIndex(item => item.id === currentPlayerId)
					);
					this.room.game.winners = (this.room.game.winners || []).filter(id => id !== target.id);
				}
				this.room.players = this.room.players.filter(item => item.id !== target.id);
				for(const targetSocket of this.ctx.getWebSockets()){
					if(targetSocket.deserializeAttachment()?.playerId === target.id){
						targetSocket.send(JSON.stringify({ type: "kicked" }));
						targetSocket.close(1000, "Removed from room by host");
					}
				}
			}else if(data.type === "rematch"){
				if(this.room.status === "complete" && this.room.game?.status === "complete"){
					this.room.game = null;
					this.room.status = "waiting";
				}else if(this.room.status !== "waiting" || this.room.game){
					throw new Error("A new game can only start after the current game is complete.");
				}
			}else if(data.type === "draw"){
				if(this.room.status !== "playing" || !this.room.game){
					throw new Error("This room is not playing a game.");
				}
				drawCard(this.room.game, player.id, data.source);
			}else if(data.type === "discard"){
				if(this.room.status !== "playing" || !this.room.game){
					throw new Error("This room is not playing a game.");
				}
				discardAndEndTurn(this.room.game, player.id, data.cardId, data.layDown === true);
				if(this.room.game.status === "complete"){
					this.room.status = "complete";
				}else{
					this.runBotTurns();
				}
			}else if(data.type === "chat"){
				if(this.room.status !== "playing" || this.room.game?.status !== "playing"){
					throw new Error("Chat is only available during an online game.");
				}
				if(typeof data.quote !== "string" || !CHAT_QUOTES.includes(data.quote)){
					throw new Error("Choose one of the available game quotes.");
				}
				this.room.chat = {
					playerName: player.name,
					quote: data.quote,
					id: createToken(8)
				};
			}else if(data.type === "close"){
				if(player.id !== this.room.hostId){
					throw new Error("Only the host can close the room.");
				}
				await this.closeRoom();
				return;
			}else if(data.type === "leave"){
				await this.leaveRoom(socket, player);
				return;
			}else{
				throw new Error("Unknown room action.");
			}
		}catch(error){
			if(error instanceof Error){
				this.sendError(socket, error.message);
				return;
			}
			throw error;
		}
		this.room.lastActivity = Date.now();
		await this.persistRoom();
		await this.refreshExpiry();
		this.broadcast();
	}

	webSocketClose(socket, code, reason){
		if(code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)){
			socket.close(code, reason);
		}else{
			socket.close();
		}
		this.broadcast();
	}

	webSocketError(){
		this.broadcast();
	}

	async alarm(){
		if(!this.room){
			return;
		}
		if(Date.now() - this.room.lastActivity < ROOM_IDLE_MS){
			await this.refreshExpiry();
			return;
		}
		this.room = null;
		await this.ctx.storage.delete("room");
		for(const socket of this.ctx.getWebSockets()){
			socket.close(1001, "Room expired");
		}
	}

	async leaderboard(request){
		if(request.method === "GET"){
			const scores = recalculateLeaderboardScores(
				await this.ctx.storage.get("scores")
			);
			await this.ctx.storage.put("scores", scores);
			return jsonResponse({ scores });
		}
		if(request.method !== "POST"){
			return jsonResponse({ error: "Method not allowed." }, 405);
		}
		const body = await readJson(request);
		if(!body){
			return jsonResponse({ error: "Invalid score submission." }, 400);
		}
		const name = cleanName(body.name);
		const score = Number(body.score);
		const turns = Number(body.turns);
		const elapsedSeconds = Number(body.elapsedSeconds);
		const useTwosWild = body.useTwosWild;
		if(!name || !Number.isSafeInteger(score) || score < 0 ||
			!Number.isSafeInteger(turns) || turns < 1 ||
			!Number.isSafeInteger(elapsedSeconds) || elapsedSeconds < 0 ||
			typeof useTwosWild !== "boolean" ||
			score !== soloRunScore(turns, elapsedSeconds)){
			return jsonResponse({ error: "Enter a name and a valid completed solo result." }, 400);
		}
		const scores = recalculateLeaderboardScores(
			await this.ctx.storage.get("scores")
		);
		scores.push({
			name,
			score,
			turns,
			elapsedSeconds,
			useTwosWild,
			submittedAt: new Date().toISOString()
		});
		const bestScores = recalculateLeaderboardScores(scores);
		await this.ctx.storage.put("scores", bestScores);
		return jsonResponse({ scores: bestScores }, 201);
	}

	getSnapshot(playerId){
		if(!this.room){
			return { type: "state", room: null };
		}
		const connectedPlayers = new Set(
			this.ctx.getWebSockets().map(socket => socket.deserializeAttachment())
				.filter(attachment => attachment?.authenticated)
				.map(attachment => attachment.playerId)
		);
		const room = {
			code: this.room.code,
			hostId: this.room.hostId,
			status: this.room.status,
			useTwosWild: this.room.useTwosWild,
			bots: (this.room.bots || []).map(({ id, name, botSkill }) => ({
				id,
				name,
				botSkill
			})),
			players: this.room.players.map(player => ({
				id: player.id,
				name: player.name,
				connected: connectedPlayers.has(player.id),
			})),
		};
		if(!this.room.game){
			return { type: "state", room, game: null, chat: this.room.chat || null };
		}
		const game = this.room.game;
		return {
			type: "state",
			room,
			chat: this.room.chat || null,
			game: {
				status: game.status,
				round: game.round,
				useTwosWild: game.useTwosWild,
				solo: game.solo,
				currentPlayerId: game.players[game.currentIndex].id,
				hasDrawn: game.hasDrawn,
				drawPileCount: game.drawPile.length,
				drawPileBackIndexes: game.drawPile.slice(-3).map(card =>
					Number(card.id.split("-")[0])
				),
				discardTop: game.discardPile[game.discardPile.length - 1] || null,
				finalTurnsRemaining: game.finalTurnsRemaining,
				wentOutPlayerId: game.wentOutPlayerId,
				wentOutPlayerName: game.wentOutPlayerName,
				players: game.players.map(player => ({
					id: player.id,
					name: player.name,
					score: player.score,
					laidDown: player.laidDown,
					isBot: player.isBot === true,
					botSkill: player.isBot === true ? player.botSkill : null,
					cardCount: player.hand.length,
					turnsThisRound: player.turnsThisRound,
				})),
				hand: game.players.find(player => player.id === playerId)?.hand || [],
				history: game.history,
				winners: game.winners || [],
			},
		};
	}

	runBotTurns(){
		const game = this.room?.game;
		while(game?.status === "playing"){
			const bot = game.players[game.currentIndex];
			if(!bot?.isBot){
				return;
			}
			playBotTurn(game, bot.id);
			if(game.status === "complete"){
				this.room.status = "complete";
				return;
			}
		}
	}

	sendError(socket, message){
		if(socket.readyState === WebSocket.OPEN){
			socket.send(JSON.stringify({ type: "error", message }));
		}
	}

	broadcast(){
		for(const socket of this.ctx.getWebSockets()){
			if(socket.readyState !== WebSocket.OPEN){
				continue;
			}
			const attachment = socket.deserializeAttachment();
			if(attachment?.authenticated){
				socket.send(JSON.stringify(this.getSnapshot(attachment.playerId)));
			}
		}
	}

	async persistRoom(){
		if(this.room){
			await this.ctx.storage.put("room", this.room);
		}
	}

	async refreshExpiry(){
		await this.ctx.storage.setAlarm(Date.now() + ROOM_IDLE_MS);
	}

	async closeRoom(){
		this.room = null;
		await this.ctx.storage.delete("room");
		await this.ctx.storage.deleteAlarm();
		for(const socket of this.ctx.getWebSockets()){
			socket.close(1000, "Room closed by host");
		}
	}

	async leaveRoom(socket, player){
		if(!this.room){
			socket.close(1000, "Room no longer exists");
			return;
		}
		const playerIndex = this.room.players.findIndex(item => item.id === player.id);
		if(playerIndex < 0){
			socket.send(JSON.stringify({ type: "left" }));
			socket.close(1000, "Player left the room");
			return;
		}
		if(this.room.status === "playing" && this.room.game?.status === "playing"){
			removePlayerFromGame(this.room.game, player.id);
			if(this.room.game.status === "complete"){
				this.room.status = "complete";
			}else{
				this.runBotTurns();
			}
		}else if(this.room.game){
			const game = this.room.game;
			const currentPlayerId = game.players[game.currentIndex]?.id;
			game.players = game.players.filter(item => item.id !== player.id);
			game.currentIndex = game.players.findIndex(item => item.id === currentPlayerId);
			if(game.currentIndex < 0){
				game.currentIndex = 0;
			}
			game.winners = (game.winners || []).filter(id => id !== player.id);
		}
		this.room.players.splice(playerIndex, 1);
		socket.send(JSON.stringify({ type: "left" }));
		socket.close(1000, "Player left the room");
		if(this.room.players.length === 0){
			this.room = null;
			await this.ctx.storage.delete("room");
			await this.ctx.storage.deleteAlarm();
			return;
		}
		this.room.lastActivity = Date.now();
		await this.persistRoom();
		await this.refreshExpiry();
		this.broadcast();
	}
}
