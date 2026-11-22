import {
	canLayDown,
	cardPoints,
	CHAT_QUOTES,
	createGame,
	createToken,
	discardAndEndTurn,
drawCard,
findAdjacentMeldGroups,
getSoloRunElapsedSeconds,
isWild,
LAST_ROUND,
soloRunScore,
skipRound
} from "./gameRules.js";

const $ = selector => document.querySelector(selector);
const infoDiv = $("#infoDiv");
const startDiv = $("#startDiv");
const localSetup = $("#localSetup");
const onlineSetup = $("#onlineSetup");
const roomLobby = $("#roomLobby");
const gameBoard = $("#gameBoard");
const handCards = $("#handCards");
const deckTarget = $("#deckTarget");
const discardTarget = $("#discardTarget");
const decisionDialog = $("#decisionDialog");
const notice = $("#notice");
const localScoreKey = "3to14:local-solo-top10";
const localGameStorageKey = "3to14:local-game";
const roomStorageKey = "3to14:room-session";
const cardBackImages = Array.from({ length: 6 }, (_, index) =>
	"Images/optimized/Queenie" + (index + 1) + ".jpg"
);
const suitImages = {
	hearts: "Images/hearts.png",
	dimonds: "Images/dimonds.png",
	clubs: "Images/clubs.png",
	spades: "Images/spades.png"
};

let mode = "local";
let localGame = null;
let onlineCredentials = null;
let onlineState = null;
let globalLeaderboardScores = null;
let socket = null;
let selectedCardId = null;
let reorderSelectedCardId = null;
let handOrder = [];
let handGapPositions = [];
let handVisible = false;
let activeHandDrag = false;
let pendingAction = false;
let pendingDrawIndex = null;
let suppressNextCardClick = false;
let suppressPileClick = false;
let manuallyLeavingRoom = false;
let reconnectTimer = null;
let roomExitTimer = null;
let reconnectAttempts = 0;
let noticeTimer = null;
let submittedSoloScore = false;
let roomEndedDialogOpen = false;
let lastTurnPromptKey = null;
let soloTimerInterval = null;
let roundLabelClickCount = 0;
let roundLabelClickTimer = null;

function showNotice(message){
	notice.textContent = message;
	notice.hidden = false;
	clearTimeout(noticeTimer);
	noticeTimer = setTimeout(() => {
		notice.hidden = true;
	}, 6000);
}

function askDecision(title, message, acceptText, denyText){
	$("#decisionTitle").textContent = title;
	$("#decisionMessage").textContent = message;
	$("#layDownHint").textContent = "";
	$("#layDownOption").hidden = true;
	$("#skipPasswordOption").hidden = true;
	$("#decisionAccept").textContent = acceptText;
	$("#decisionDeny").textContent = denyText;
	$("#decisionDeny").hidden = false;
	return new Promise(resolve => {
		const finish = accepted => {
			decisionDialog.close();
			resolve(accepted);
		};
		$("#decisionAccept").onclick = () => finish(true);
		$("#decisionDeny").onclick = () => finish(false);
		decisionDialog.showModal();
		$("#decisionDeny").focus();
	});
}

function askDiscardDecision(canLayDownNow){
	$("#decisionTitle").textContent = "Discard this card?";
	$("#decisionMessage").textContent = "Discarding ends your turn.";
	$("#layDownHint").textContent = canLayDownNow
		? "Your remaining cards can be laid down as complete sets or runs."
		: "You cannot lay down yet; your remaining cards do not make complete sets or runs.";
	$("#layDownOption").hidden = !canLayDownNow;
	$("#skipPasswordOption").hidden = true;
	$("#layDownCheckbox").checked = canLayDownNow;
	$("#decisionAccept").textContent = "Discard card";
	$("#decisionDeny").textContent = "Keep card";
	return new Promise(resolve => {
		const finish = discard => {
			decisionDialog.close();
			resolve({ discard, layDown: discard && canLayDownNow && $("#layDownCheckbox").checked });
		};
		$("#decisionAccept").onclick = () => finish(true);
		$("#decisionDeny").onclick = () => finish(false);
		decisionDialog.showModal();
		$("#decisionDeny").focus();
	});
}

function resumeSoloTimer(game){
	if(!game?.solo || !Number.isFinite(game.soloPausedAt)){
		return;
	}
	game.soloPausedMilliseconds = (game.soloPausedMilliseconds || 0) +
		Math.max(0, Date.now() - game.soloPausedAt);
	game.soloPausedAt = null;
	game.soloElapsedSeconds = null;
}

function pauseSoloTimer(game){
	if(!game?.solo || game.status !== "playing" || Number.isFinite(game.soloPausedAt)){
		return;
	}
	game.soloPausedAt = Date.now();
	game.soloElapsedSeconds = getSoloRunElapsedSeconds(game);
}

function isSavedCard(card){
	return card && typeof card.id === "string" &&
		(card.rank === "Joker"
			? card.suit === "Joker"
			: Number.isInteger(card.rank) && card.rank >= 2 && card.rank <= 14 &&
				["hearts", "dimonds", "clubs", "spades"].includes(card.suit));
}

function isSavedLocalGame(game){
	return game && typeof game === "object" && game.status === "playing" &&
		Number.isInteger(game.round) && game.round >= 3 && game.round <= 14 &&
		typeof game.useTwosWild === "boolean" && typeof game.solo === "boolean" &&
		typeof game.hasDrawn === "boolean" &&
		Array.isArray(game.players) && game.players.length >= 1 && game.players.length <= 20 &&
		(!game.solo || game.players.length === 1) &&
		Number.isInteger(game.currentIndex) && game.currentIndex >= 0 &&
		game.currentIndex < game.players.length &&
		game.players.every(player =>
			player && typeof player.id === "string" && typeof player.name === "string" &&
			Number.isFinite(player.score) && Number.isInteger(player.turnsThisRound) &&
			typeof player.laidDown === "boolean" && Array.isArray(player.hand) &&
			player.hand.every(isSavedCard)
		) &&
		Array.isArray(game.drawPile) && game.drawPile.every(isSavedCard) &&
		Array.isArray(game.discardPile) && game.discardPile.length > 0 &&
		game.discardPile.every(isSavedCard) && Array.isArray(game.history);
}

function formatElapsedTime(totalSeconds){
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainder = seconds % 60;
	return [hours, minutes, remainder].map(value => String(value).padStart(2, "0")).join(":");
}

function getSoloElapsedSeconds(game, now = Date.now()){
	return getSoloRunElapsedSeconds(game, now);
}

function updateSoloTimer(){
	const timer = $("#soloTimer");
	if(!timer || mode !== "local" || !localGame?.solo || localGame.status !== "playing"){
		if(timer){
			timer.hidden = true;
		}
		return;
	}
	timer.hidden = false;
	timer.textContent = "Time: " + formatElapsedTime(getSoloElapsedSeconds(localGame));
}

function closeScoreboard(){
	$("#scoreBoard").hidden = true;
	if(mode === "local"){
		resumeSoloTimer(localGame);
		persistLocalGame();
		updateSoloTimer();
	}
}

function removeSavedLocalGame(){
	try{
		localStorage.removeItem(localGameStorageKey);
	}catch(error){
		showNotice("The saved local game could not be removed from this device.");
	}
}

function persistLocalGame(){
	if(!localGame){
		return;
	}
	if(localGame.status !== "playing"){
		removeSavedLocalGame();
		return;
	}
	try{
		localStorage.setItem(localGameStorageKey, JSON.stringify(localGame));
	}catch(error){
		showNotice("Your current game could not be saved on this device.");
	}
}

function restoreSavedLocalGame(){
	let saved;
	try{
		saved = localStorage.getItem(localGameStorageKey);
	}catch(error){
		showNotice("The saved local game could not be read from this device.");
		return false;
	}
	if(!saved){
		return false;
	}
	let game;
	try{
		game = JSON.parse(saved);
	}catch(error){
		showNotice("The saved local game is damaged and could not be restored.");
		removeSavedLocalGame();
		return false;
	}
	if(!isSavedLocalGame(game)){
		showNotice("The saved local game is invalid and could not be restored.");
		removeSavedLocalGame();
		return false;
	}
	if(game.solo && !Number.isSafeInteger(game.soloTotalTurns)){
		const historicalTurns = game.history.reduce((total, entry) =>
			total + (entry.scores[0]?.turns || 0), 0);
		game.soloTotalTurns = historicalTurns || game.players[0].score;
		game.players[0].score = 0;
		game.soloStartedAt = null;
		game.soloElapsedSeconds = null;
	}
	if(game.solo){
		game.soloPausedMilliseconds = game.soloPausedMilliseconds || 0;
		resumeSoloTimer(game);
	}
	localGame = game;
	mode = "local";
	handVisible = game.solo;
	selectedCardId = null;
	handOrder = [];
	$("#scoreBoard").hidden = true;
	$("#playAgain").hidden = true;
	renderLocalGame();
	return true;
}

function setMode(nextMode){
	mode = nextMode;
	document.querySelectorAll(".mode-button").forEach(button => {
		const active = button.dataset.mode === mode;
		button.classList.toggle("active", active);
		button.setAttribute("aria-pressed", String(active));
	});
	localSetup.hidden = mode !== "local";
	onlineSetup.hidden = mode !== "online";
}

function renderPlayerNames(){
	const count = Number($("#playerCount").value);
	if(!Number.isInteger(count) || count < 1 || count > 20){
		return;
	}
	const oldNames = Array.from($("#playerNames").querySelectorAll("input"), input => input.value);
	const fields = $("#playerNames");
	fields.replaceChildren();
	for(let index = 0; index < count; index++){
		const label = document.createElement("label");
		label.textContent = "Player " + (index + 1) + " name";
		const input = document.createElement("input");
		input.type = "text";
		input.maxLength = 20;
		input.autocomplete = "off";
		input.value = oldNames[index] || "";
		input.setAttribute("aria-label", "Player " + (index + 1) + " name");
		label.appendChild(input);
		fields.appendChild(label);
	}
}

function readLocalScores(){
	try{
		const saved = localStorage.getItem(localScoreKey);
		const storedScores = saved ? JSON.parse(saved) : [];
		if(!Array.isArray(storedScores)){
			return [];
		}
		const scores = storedScores
			.filter(entry => typeof entry?.useTwosWild === "boolean")
			.map(entry => Number.isSafeInteger(entry.turns) && entry.turns >= 0 &&
				Number.isSafeInteger(entry.elapsedSeconds) && entry.elapsedSeconds >= 0
				? { ...entry, score: soloRunScore(entry.turns, entry.elapsedSeconds) }
				: entry)
			.sort((first, second) => second.score - first.score ||
				(first.elapsedSeconds ?? Number.MAX_SAFE_INTEGER) -
					(second.elapsedSeconds ?? Number.MAX_SAFE_INTEGER) ||
				(first.turns ?? Number.MAX_SAFE_INTEGER) -
					(second.turns ?? Number.MAX_SAFE_INTEGER));
		const retained = [
			...scores.filter(entry => entry.useTwosWild === false).slice(0, 10),
			...scores.filter(entry => entry.useTwosWild === true).slice(0, 10)
		];
		try{
			localStorage.setItem(localScoreKey, JSON.stringify(retained));
		}catch(error){
			showNotice("Saved solo scores could not be updated with the current scoring formula.");
		}
		return retained;
	}catch(error){
		showNotice("Could not load this device's saved scores.");
		return [];
	}
}

function renderLeaderboard(list, scores, emptyText, wildSetting){
	list.replaceChildren();
	const applicableScores = scores.filter(entry => entry.useTwosWild === wildSetting);
	if(applicableScores.length === 0){
		const item = document.createElement("li");
		item.textContent = emptyText;
		list.appendChild(item);
		return;
	}
	const rankedScores = [...applicableScores].sort((first, second) =>
		second.score - first.score ||
		(first.elapsedSeconds ?? Number.MAX_SAFE_INTEGER) -
			(second.elapsedSeconds ?? Number.MAX_SAFE_INTEGER) ||
		(first.turns ?? Number.MAX_SAFE_INTEGER) - (second.turns ?? Number.MAX_SAFE_INTEGER)
	);
	for(const entry of rankedScores.slice(0, 10)){
		const item = document.createElement("li");
		const hasRunDetails = Number.isSafeInteger(entry.turns) &&
			Number.isSafeInteger(entry.elapsedSeconds);
		item.textContent = hasRunDetails
			? entry.name + " — " + entry.score.toLocaleString() + " points · " +
				entry.turns + " turns · " + formatElapsedTime(entry.elapsedSeconds)
			: entry.name + " — Legacy score (run details unavailable)";
		list.appendChild(item);
	}
}

function renderScoreboards(scores = null){
	const useTwosWild = $("#leaderboardWildFilter").checked;
	const localScores = scores?.local ?? readLocalScores();
	const globalScores = scores?.global ?? globalLeaderboardScores;
	renderLeaderboard(
		$("#localScores"),
		localScores,
		"No local solo scores yet.",
		useTwosWild
	);
	if(globalScores){
		renderLeaderboard(
			$("#globalScores"),
			globalScores,
			"No scores yet.",
			useTwosWild
		);
	}
}

async function loadGlobalScores(){
	try{
		const result = await requestJson("/api/leaderboard");
		globalLeaderboardScores = result.scores || [];
		renderScoreboards({ global: globalLeaderboardScores });
	}catch(error){
		globalLeaderboardScores = [];
		renderLeaderboard(
			$("#globalScores"),
			[],
			"Global scores are unavailable.",
			$("#leaderboardWildFilter").checked
		);
	}
}

async function requestJson(url, options = {}){
	let response;
	try{
		response = await fetch(url, options);
	}catch(error){
		throw new Error("Could not connect to the game server.");
	}
	let result;
	try{
		result = await response.json();
	}catch(error){
		throw new Error("The server returned an invalid response.");
	}
	if(!response.ok){
		throw new Error(result.error || "The request could not be completed.");
	}
	return result;
}

function refreshLocalScores(){
	renderScoreboards({ local: readLocalScores() });
}

function saveSoloScore(player, game){
	const scores = readLocalScores();
	scores.push({
		name: player.name,
		score: player.score,
		turns: game.soloTotalTurns,
		elapsedSeconds: game.soloElapsedSeconds,
		useTwosWild: game.useTwosWild,
		date: new Date().toISOString()
	});
	scores.sort((first, second) => second.score - first.score ||
		(first.elapsedSeconds ?? Number.MAX_SAFE_INTEGER) -
			(second.elapsedSeconds ?? Number.MAX_SAFE_INTEGER) ||
		(first.turns ?? Number.MAX_SAFE_INTEGER) - (second.turns ?? Number.MAX_SAFE_INTEGER) ||
		first.date.localeCompare(second.date));
	try{
		const ranked = scores.sort((first, second) => second.score - first.score ||
			(first.elapsedSeconds ?? Number.MAX_SAFE_INTEGER) -
				(second.elapsedSeconds ?? Number.MAX_SAFE_INTEGER) ||
			(first.turns ?? Number.MAX_SAFE_INTEGER) - (second.turns ?? Number.MAX_SAFE_INTEGER) ||
			(first.date || "").localeCompare(second.date || ""));
		const retained = [
			...ranked.filter(entry => entry.useTwosWild === false).slice(0, 10),
			...ranked.filter(entry => entry.useTwosWild === true).slice(0, 10),
			...ranked.filter(entry => typeof entry.useTwosWild !== "boolean").slice(0, 10)
		];
		localStorage.setItem(localScoreKey, JSON.stringify(retained));
	}catch(error){
		showNotice("Your solo score could not be saved on this device.");
	}
	refreshLocalScores();
}

async function submitGlobalScore(player, game){
	try{
		const result = await requestJson("/api/leaderboard", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: player.name,
				score: player.score,
				turns: game.soloTotalTurns,
				elapsedSeconds: game.soloElapsedSeconds,
				useTwosWild: game.useTwosWild
			})
		});
		globalLeaderboardScores = result.scores || [];
		renderScoreboards({ global: globalLeaderboardScores });
	}catch(error){
		showNotice("Your local score was saved, but the global score could not be submitted: " + error.message);
	}
}

function currentLocalPlayer(){
	return localGame?.players[localGame.currentIndex] || null;
}

function drawCardElement(card, index, enabled, handCard = false){
	const element = document.createElement("div");
	element.className = "card";
	element.draggable = false;
	element.dataset.cardId = card.id;
	element.dataset.index = String(index);
	if(handCard){
		element.classList.add("hand-card");
		enableCardDragging(element, card.id);
	}
	const clickable = enabled || handCard;
	if(clickable){
		element.setAttribute("role", "button");
		element.setAttribute("tabindex", "0");
		const selected = enabled
			? card.id === selectedCardId
			: card.id === reorderSelectedCardId;
		element.setAttribute("aria-pressed", String(selected));
		element.setAttribute("aria-label", card.suit === "Joker" ? "Joker" : card.rank + " of " + card.suit);
		element.classList.toggle("selected", selected);
		element.addEventListener("click", () => {
			if(suppressNextCardClick){
				return;
			}
			if(enabled){
				selectCard(card.id);
			}else{
				selectHandCardForReorder(card.id);
			}
		});
		element.addEventListener("keydown", event => {
			if(event.key === "Enter" || event.key === " "){
				event.preventDefault();
				if(enabled){
					selectCard(card.id);
				}else{
					selectHandCardForReorder(card.id);
				}
			}
		});
	}else{
		element.setAttribute("aria-hidden", "true");
	}
	const rankLabel = { 11: "J", 12: "Q", 13: "K", 14: "A" }[card.rank] || card.rank;
	const color = card.suit === "hearts" || card.suit === "dimonds" ? "#bd2635" : "#18221c";
	for(const className of ["card-rank card-rank-top", "card-rank card-rank-bottom"]){
		const rank = document.createElement("span");
		rank.className = className;
		rank.textContent = rankLabel;
		rank.style.color = card.suit === "Joker" ? "#7a2c91" : color;
		element.appendChild(rank);
	}
	if(card.suit === "Joker"){
		const image = document.createElement("img");
		image.className = "card-joker-image";
		image.src = "Images/optimized/CalciferFan.jpg";
		image.alt = "Joker artwork";
		image.loading = "lazy";
		image.decoding = "async";
		element.appendChild(image);
	}else{
		element.style.backgroundImage = "url(" + suitImages[card.suit] + ")";
		for(const className of ["card-suit card-suit-top", "card-suit card-suit-bottom"]){
			const image = document.createElement("img");
			image.className = className;
			image.src = suitImages[card.suit];
			image.alt = "";
			image.draggable = false;
			image.setAttribute("aria-hidden", "true");
			image.loading = "lazy";
			image.decoding = "async";
			element.appendChild(image);
		}
	}
	const currentGame = mode === "online" ? onlineState?.game : localGame;
	if(currentGame && isWild(card, currentGame.round, currentGame.useTwosWild)){
		element.classList.add("wild-card");
		const wildBadge = document.createElement("span");
		wildBadge.className = "card-wild-badge";
		wildBadge.textContent = "WILD";
		element.appendChild(wildBadge);
		const label = element.getAttribute("aria-label");
		if(label){
			element.setAttribute("aria-label", label + ", wild card");
		}
	}
	return element;
}

function getDisplayedHand(cards){
	if(mode !== "online"){
		return cards;
	}
	const byId = new Map(cards.map(card => [card.id, card]));
	handOrder = Array.from(new Set(handOrder.filter(id => byId.has(id))));
	for(const card of cards){
		if(!handOrder.includes(card.id)){
			handOrder.push(card.id);
		}
	}
	return handOrder.map(id => byId.get(id));
}

function selectCard(cardId){
	const hand = getOwnHand();
	if(!hand.some(card => card.id === cardId)){
		return;
	}
	if(selectedCardId === null){
		selectedCardId = cardId;
	}else if(selectedCardId === cardId){
		selectedCardId = null;
	}else{
		reorderCards(selectedCardId, cardId);
		return;
	}
	renderCurrentGame();
}

function selectHandCardForReorder(cardId){
	if(!getOwnHand().some(card => card.id === cardId)){
		return;
	}
	if(reorderSelectedCardId === null){
		reorderSelectedCardId = cardId;
		renderCurrentGame();
	}else if(reorderSelectedCardId === cardId){
		reorderSelectedCardId = null;
		renderCurrentGame();
	}else{
		const fromId = reorderSelectedCardId;
		reorderSelectedCardId = null;
		reorderCards(fromId, cardId);
	}
}

function getOwnHand(){
	if(mode === "online"){
		return onlineState?.game?.hand || [];
	}
	return currentLocalPlayer()?.hand || [];
}

function reorderCards(fromId, toId){
	const hand = getOwnHand();
	const from = hand.findIndex(card => card.id === fromId);
	const to = hand.findIndex(card => card.id === toId);
	if(from < 0 || to < 0 || from === to){
		return;
	}
	if(mode === "online"){
		const order = getDisplayedHand(hand).map(card => card.id);
		const displayedFrom = order.indexOf(fromId);
		const displayedTo = order.indexOf(toId);
		[order[displayedFrom], order[displayedTo]] =
			[order[displayedTo], order[displayedFrom]];
		handOrder = order;
	}else{
		[hand[from], hand[to]] = [hand[to], hand[from]];
	}
	selectedCardId = null;
	reorderSelectedCardId = null;
	renderCurrentGame();
}

function enableCardDragging(element, cardId){
	let drag = null;
	const handleMove = event => {
		if(!drag || drag.id !== event.pointerId){
			return;
		}
		if(!drag.dragging && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 7){
			drag.dragging = true;
			activeHandDrag = true;
			drag.ghost = element.cloneNode(true);
			drag.ghost.className = "card hand-drag-ghost";
			drag.ghost.setAttribute("aria-hidden", "true");
			drag.ghost.style.width = element.offsetWidth + "px";
			drag.ghost.style.height = element.offsetHeight + "px";
			document.body.appendChild(drag.ghost);
			element.classList.add("drag-placeholder");
			addHandDropSlots(cardId);
		}
		if(drag.dragging){
			drag.ghost.style.left = event.clientX - drag.offsetX + "px";
			drag.ghost.style.top = event.clientY - drag.offsetY + "px";
			const target = document.elementFromPoint(event.clientX, event.clientY);
			discardTarget.classList.toggle("drop-target-active", Boolean(target && discardTarget.contains(target)));
			scheduleHandPlaceholder(element, drag, event.clientX, event.clientY);
		}
	};
	const removePointerListeners = () => {
		document.removeEventListener("pointermove", handleMove);
		document.removeEventListener("pointerup", handleUp);
		document.removeEventListener("pointercancel", handleCancel);
	};
	const handleUp = event => {
		if(!drag || drag.id !== event.pointerId){
			return;
		}
		const dropSlot = drag.dragging
			? Array.from(handCards.querySelectorAll(".hand-drop-slot"))
				.filter(slot => !slot.classList.contains("hand-drop-slot-reserved") ||
					slot.classList.contains("is-active"))
				.find(slot => {
				const rect = slot.getBoundingClientRect();
				return event.clientX >= rect.left && event.clientX <= rect.right &&
					event.clientY >= rect.top && event.clientY <= rect.bottom;
			})
			: null;
		if(drag.dragging && !dropSlot && isInsideHand(event.clientX, event.clientY)){
			clearTimeout(drag.reorderTimer);
			updateHandPlaceholder(element, event.clientX, event.clientY);
		}
		const target = drag.dragging ? document.elementFromPoint(event.clientX, event.clientY) : null;
		const dropOnDiscard = Boolean(target && discardTarget.contains(target));
		const wasDragging = drag.dragging;
		clearTimeout(drag.reorderTimer);
		drag.ghost?.remove();
		drag = null;
		activeHandDrag = false;
		removePointerListeners();
		discardTarget.classList.remove("drop-target-active");
		if(!wasDragging){
			clearHandDropSlots();
			return;
		}
		suppressNextCardClick = true;
		setTimeout(() => {
			suppressNextCardClick = false;
		}, 0);
		element.classList.remove("drag-placeholder");
		if(dropOnDiscard){
			clearHandDropSlots();
			handGapPositions = [];
			renderCurrentGame();
			void discardCard(cardId);
		}else{
			const cardsInOrder = Array.from(handCards.querySelectorAll(".hand-card"));
			const draggedCardIndex = cardsInOrder.findIndex(card =>
				card.dataset.cardId === cardId
			);
			const droppedIntoTrailingReservedSlot = dropSlot?.classList.contains(
				"hand-drop-slot-reserved"
			) && draggedCardIndex === cardsInOrder.length - 1;
			if(droppedIntoTrailingReservedSlot){
				const activeReservedSlots = Array.from(
					handCards.querySelectorAll(".hand-drop-slot-reserved.is-active")
				);
				const selectedSlotIndex = activeReservedSlots.indexOf(dropSlot);
				for(const slot of activeReservedSlots.slice(0, selectedSlotIndex + 1)){
					handCards.insertBefore(slot, element);
				}
				activeReservedSlots.slice(selectedSlotIndex + 1).forEach(slot => slot.remove());
			}else if(dropSlot){
				handCards.insertBefore(element, dropSlot.nextSibling);
				dropSlot.remove();
			}
			clearHandDropSlots(true);
			keepHandDropSlotsBetweenCards();
			commitHandOrder();
		}
	};
	const handleCancel = event => {
		if(!drag || drag.id !== event.pointerId){
			return;
		}
		clearTimeout(drag.reorderTimer);
		drag.ghost?.remove();
		drag = null;
		activeHandDrag = false;
		clearHandDropSlots();
		removePointerListeners();
		discardTarget.classList.remove("drop-target-active");
		element.classList.remove("drag-placeholder");
		renderCurrentGame();
	};
	element.addEventListener("pointerdown", event => {
		if(drag){
			return;
		}
		if(event.pointerType === "mouse" && event.button !== 0){
			return;
		}
		const rect = element.getBoundingClientRect();
		drag = {
			x: event.clientX,
			y: event.clientY,
			offsetX: event.clientX - rect.left,
			offsetY: event.clientY - rect.top,
			id: event.pointerId,
			dragging: false,
			ghost: null,
			reorderTimer: null
		};
		document.addEventListener("pointermove", handleMove);
		document.addEventListener("pointerup", handleUp);
		document.addEventListener("pointercancel", handleCancel);
	});
}

function addHandDropSlots(cardId){
	handCards.classList.add("is-organizing");
	const handCardsInOrder = Array.from(handCards.querySelectorAll(".hand-card"));
	if(!handCardsInOrder.some(card => card.dataset.cardId === cardId)){
		return;
	}
	const slotsToAdd = getAvailableTrailingHandDropSlots(cardId, handCardsInOrder);
	handCards.querySelectorAll(".hand-drop-slot-reserved")
		.forEach((slot, index) => slot.classList.toggle("is-active", index < slotsToAdd));
}

function getAvailableTrailingHandDropSlots(cardId, cardsInOrder){
	const movingIndex = cardsInOrder.findIndex(card => card.dataset.cardId === cardId);
	if(movingIndex !== cardsInOrder.length - 1){
		return 3;
	}
	const cardCount = cardsInOrder.length;
	const existingTrailingGaps = handGapPositions.filter(position =>
		position === cardCount - 1
	).length;
	return Math.max(0, 3 - existingTrailingGaps);
}

function clearHandDropSlots(preserve = false){
	handCards.querySelectorAll(".hand-drop-slot-reserved").forEach(slot =>
		slot.classList.remove("is-active")
	);
	handCards.querySelectorAll(".hand-drop-slot-temporary").forEach(slot => {
		if(slot.classList.contains("hand-drop-slot-reserved")){
			return;
		}
		if(preserve){
			slot.classList.remove("hand-drop-slot-temporary");
		}else{
			slot.remove();
		}
	});
	handCards.classList.remove("is-organizing");
}

function keepHandDropSlotsBetweenCards(){
	const items = Array.from(handCards.children).filter(item =>
		item.classList.contains("hand-card") || item.classList.contains("hand-drop-slot")
	);
	const firstCard = items.findIndex(item => item.classList.contains("hand-card"));
	let lastCard = -1;
	for(let index = firstCard; index < items.length; index++){
		if(items[index].classList.contains("hand-card")){
			lastCard = index;
		}
	}
	items.forEach((item, index) => {
		if(item.classList.contains("hand-drop-slot") &&
			!item.classList.contains("hand-drop-slot-reserved") &&
			(index < firstCard || index > lastCard)){
			item.remove();
		}
	});
}

function scheduleHandPlaceholder(placeholder, drag, x, y){
	drag.pendingX = x;
	drag.pendingY = y;
	if(drag.reorderTimer !== null){
		return;
	}
	drag.reorderTimer = setTimeout(() => {
		drag.reorderTimer = null;
		updateHandPlaceholder(placeholder, drag.pendingX, drag.pendingY);
	}, 80);
}

function isInsideHand(x, y){
	const rect = handCards.getBoundingClientRect();
	return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function enablePileDragging(element, source){
	let drag = null;
	const handleMove = event => {
		if(!drag || drag.id !== event.pointerId){
			return;
		}
		if(!drag.dragging && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 7){
			drag.dragging = true;
			drag.ghost = drag.card.cloneNode(true);
			drag.ghost.classList.add("hand-drag-ghost");
			drag.ghost.setAttribute("aria-hidden", "true");
			drag.ghost.style.width = drag.card.offsetWidth + "px";
			drag.ghost.style.height = drag.card.offsetHeight + "px";
			document.body.appendChild(drag.ghost);
			drag.marker = document.createElement("div");
			drag.marker.className = "hand-drop-placeholder";
			drag.marker.setAttribute("aria-hidden", "true");
			drag.marker.style.width = drag.card.offsetWidth + "px";
			drag.marker.style.height = drag.card.offsetHeight + "px";
			handCards.appendChild(drag.marker);
		}
		if(drag.dragging){
			drag.ghost.style.left = event.clientX - drag.offsetX + "px";
			drag.ghost.style.top = event.clientY - drag.offsetY + "px";
			const overHand = isInsideHand(event.clientX, event.clientY);
			drag.marker.hidden = !overHand;
			if(overHand){
				scheduleHandPlaceholder(drag.marker, drag, event.clientX, event.clientY);
			}
		}
	};
	const removePointerListeners = () => {
		document.removeEventListener("pointermove", handleMove);
		document.removeEventListener("pointerup", handleUp);
		document.removeEventListener("pointercancel", handleCancel);
	};
	const cleanup = () => {
		clearTimeout(drag.reorderTimer);
		drag.ghost?.remove();
		drag.marker?.remove();
		drag = null;
		removePointerListeners();
	};
	const handleUp = event => {
		if(!drag || drag.id !== event.pointerId){
			return;
		}
		const wasDragging = drag.dragging;
		const overHand = wasDragging && isInsideHand(event.clientX, event.clientY);
		if(overHand){
			clearTimeout(drag.reorderTimer);
			updateHandPlaceholder(drag.marker, event.clientX, event.clientY);
		}
		const insertionIndex = overHand
			? Array.from(handCards.children).indexOf(drag.marker)
			: null;
		cleanup();
		if(!wasDragging){
			return;
		}
		suppressPileClick = true;
		setTimeout(() => {
			suppressPileClick = false;
		}, 0);
		if(overHand && insertionIndex !== null && insertionIndex >= 0){
			void drawFrom(source, insertionIndex);
		}
	};
	const handleCancel = event => {
		if(!drag || drag.id !== event.pointerId){
			return;
		}
		cleanup();
	};

	element.addEventListener("pointerdown", event => {
		if(drag || element.disabled || (event.pointerType === "mouse" && event.button !== 0)){
			return;
		}
		const card = source === "deck"
			? element.lastElementChild
			: element.querySelector(".card");
		if(!card){
			return;
		}
		const rect = card.getBoundingClientRect();
		drag = {
			x: event.clientX,
			y: event.clientY,
			offsetX: event.clientX - rect.left,
			offsetY: event.clientY - rect.top,
			id: event.pointerId,
			card,
			dragging: false,
			ghost: null,
			marker: null,
			reorderTimer: null
		};
		document.addEventListener("pointermove", handleMove);
		document.addEventListener("pointerup", handleUp);
		document.addEventListener("pointercancel", handleCancel);
	});
}

function updateHandPlaceholder(placeholder, x, y){
	const items = Array.from(handCards.children).filter(item =>
		item !== placeholder &&
		(item.classList.contains("hand-card") || item.classList.contains("hand-drop-slot"))
	);
	if(items.length === 0){
		return;
	}
	const rows = [];
	for(const item of items){
		const rect = item.getBoundingClientRect();
		let row = rows.find(candidate => Math.abs(candidate.top - rect.top) < 2);
		if(!row){
			row = { top: rect.top, cards: [] };
			rows.push(row);
		}
		row.cards.push({ item, centerX: rect.left + rect.width / 2 });
	}
	rows.sort((first, second) => first.top - second.top);
	const rowIndex = rows.reduce((closest, row, index) =>
		Math.abs(y - (row.top + row.cards[0].item.getBoundingClientRect().height / 2)) <
			Math.abs(y - (rows[closest].top + rows[closest].cards[0].item.getBoundingClientRect().height / 2))
			? index
			: closest, 0);
	const targetRow = rows[rowIndex];
	const indexInRow = targetRow.cards.findIndex(item => x < item.centerX);
	const insertionPoint = indexInRow < 0
		? rows[rowIndex + 1]?.cards[0].item || null
		: targetRow.cards[indexInRow].item;
	if(insertionPoint === placeholder.nextElementSibling ||
		(!insertionPoint && placeholder.nextElementSibling === null)){
		return;
	}
	const beforePositions = new Map([
		...items.map(item => [item, item.getBoundingClientRect()]),
		[placeholder, placeholder.getBoundingClientRect()]
	]);
	handCards.insertBefore(placeholder, insertionPoint);
	animateHandReflow(beforePositions);
}

function animateHandReflow(beforePositions){
	for(const [item, previous] of beforePositions){
		const current = item.getBoundingClientRect();
		const x = previous.left - current.left;
		const y = previous.top - current.top;
		if(x === 0 && y === 0){
			continue;
		}
		item.style.transition = "none";
		item.style.transform = "translate(" + x + "px, " + y + "px)";
		void item.offsetWidth;
		requestAnimationFrame(() => {
			item.style.transition = "";
			item.style.transform = "";
		});
	}
}

function commitHandOrder(){
	const hand = getOwnHand();
	const cardsById = new Map(hand.map(card => [card.id, card]));
	const layout = Array.from(handCards.children).filter(item =>
		item.classList.contains("hand-card") || item.classList.contains("hand-drop-slot")
	);
	const firstCard = layout.findIndex(item => item.classList.contains("hand-card"));
	let lastCard = -1;
	for(let index = firstCard; index < layout.length; index++){
		if(layout[index].classList.contains("hand-card")){
			lastCard = index;
		}
	}
	const handLayout = firstCard < 0 ? [] : layout.slice(firstCard, lastCard + 1);
	const orderedIds = Array.from(new Set(
		handLayout.filter(item => item.classList.contains("hand-card"))
			.map(card => card.dataset.cardId)
			.filter(id => cardsById.has(id))
	));
	const gapPositions = [];
	let cardsBeforeGap = 0;
	for(const item of handLayout){
		if(item.classList.contains("hand-drop-slot")){
			gapPositions.push(cardsBeforeGap);
		}else{
			cardsBeforeGap++;
		}
	}
	for(const card of hand){
		if(!orderedIds.includes(card.id)){
			orderedIds.push(card.id);
		}
	}
	const lastCardGapPosition = orderedIds.length - 1;
	let trailingGapCount = 0;
	handGapPositions = gapPositions.filter(position => {
		if(position !== lastCardGapPosition){
			return true;
		}
		trailingGapCount++;
		return trailingGapCount <= 3;
	});
	if(mode === "online"){
		handOrder = orderedIds;
	}else{
		currentLocalPlayer().hand = orderedIds.map(id => cardsById.get(id));
		persistLocalGame();
	}
	reorderSelectedCardId = null;
	renderCurrentGame();
}

function moveHandCardToIndex(cardId, targetIndex){
	const hand = getOwnHand();
	if(mode === "online"){
		const order = getDisplayedHand(hand).map(card => card.id);
		const fromIndex = order.indexOf(cardId);
		if(fromIndex < 0){
			return;
		}
		order.splice(fromIndex, 1);
		order.splice(Math.max(0, Math.min(targetIndex, order.length)), 0, cardId);
		handOrder = order;
	}else{
		const fromIndex = hand.findIndex(card => card.id === cardId);
		if(fromIndex < 0){
			return;
		}
		const [card] = hand.splice(fromIndex, 1);
		hand.splice(Math.max(0, Math.min(targetIndex, hand.length)), 0, card);
		persistLocalGame();
	}
	selectedCardId = null;
	reorderSelectedCardId = null;
	renderCurrentGame();
}

function renderCurrentGame(){
	if(mode === "online"){
		renderOnlineGame();
	}else if(localGame){
		renderLocalGame();
	}
}

function showTurnDialog(){
	$("#scoreBoard").hidden = true;
	if($("#howToPlayDialog").open){
		$("#howToPlayDialog").close();
	}
	if(decisionDialog.open && !roomEndedDialogOpen){
		$("#decisionDeny").click();
	}
	const dialog = $("#turnDialog");
	if(!dialog.open){
		dialog.showModal();
	}
	$("#turnDialogPlay").focus();
}

function renderGameTable(game, hand, canAct, canDraw, hasDrawn, canSeeHand){
	$("#roundLabel").textContent = "Round " + game.round +
		(game.round === 14 ? " (last round)" : "");
	const wildCards = [game.round + "s", "Jokers"];
	if(game.useTwosWild){
		wildCards.push("2s");
	}
	$("#wildLabel").textContent = "Wild: " + wildCards.join(", ");
	$("#deckCount").textContent = "(" + game.drawPileCount + ")";
	deckTarget.classList.toggle("can-draw", canDraw && game.drawPileCount > 0 && !pendingAction);
	discardTarget.classList.toggle(
		"can-draw",
		canDraw && Boolean(game.discardTop) && !pendingAction
	);
	discardTarget.classList.toggle(
		"can-discard",
		canAct && hasDrawn && selectedCardId !== null && !pendingAction
	);
	const finalTurnsRemaining = Number.isInteger(game.finalTurnsRemaining)
		? game.finalTurnsRemaining
		: null;
	const lastTurnBanner = $("#lastTurnBanner");
	lastTurnBanner.hidden = finalTurnsRemaining === null || finalTurnsRemaining <= 0;
	const currentPlayerLastTurn = !lastTurnBanner.hidden && !game.currentPlayerLaidDown;
	lastTurnBanner.classList.toggle(
		"urgent",
		currentPlayerLastTurn
	);
	if(!lastTurnBanner.hidden){
		const goneOutPlayerName = game.wentOutPlayerName ||
			game.players?.find(player => player.id === game.wentOutPlayerId)?.name ||
			game.players?.find(player => player.laidDown)?.name ||
			"A player";
		if(currentPlayerLastTurn){
			lastTurnBanner.textContent = "LAST TURN — " + goneOutPlayerName +
				" has gone out!";
		}else{
			lastTurnBanner.textContent = goneOutPlayerName +
				" has gone out — players who haven't laid down get one last turn.";
		}
	}
	deckTarget.replaceChildren();
	deckTarget.disabled = !canDraw || pendingAction;
	if(game.drawPileCount > 0){
		for(let index = 0; index < 3; index++){
			const back = document.createElement("div");
			back.className = "cardBack deck-stack-card-" + (index + 1);
			back.draggable = false;
			const requestedBackIndex = game.drawPileBackIndexes?.[
				Math.min(index, Math.max(0, game.drawPileBackIndexes.length - 1))
			] ?? 0;
			const deckBackIndex = Number.isSafeInteger(requestedBackIndex) &&
				requestedBackIndex >= 0 ? requestedBackIndex : 0;
			back.style.backgroundImage = "url(" +
				cardBackImages[deckBackIndex % cardBackImages.length] + ")";
			deckTarget.appendChild(back);
		}
	}
	discardTarget.replaceChildren();
	discardTarget.disabled = !(canAct && (
		(hasDrawn && selectedCardId !== null) ||
		(!hasDrawn && game.discardTop)
	)) || pendingAction;
	if(game.discardTop){
		discardTarget.appendChild(drawCardElement(game.discardTop, -1, false));
	}
	if(!activeHandDrag){
		handCards.replaceChildren();
		$("#handDiv").hidden = !canSeeHand;
		if(canSeeHand){
			const shownHand = getDisplayedHand(hand);
			handGapPositions = handGapPositions.filter(position =>
				Number.isInteger(position) && position > 0 && position < shownHand.length
			);
			const enabled = canAct && hasDrawn && !pendingAction;
			const groups = findAdjacentMeldGroups(
				shownHand,
				game.round,
				game.useTwosWild
			);
			const groupByIndex = new Map();
			groups.forEach((group, groupIndex) => {
				for(let index = group.start; index < group.end; index++){
					groupByIndex.set(index, {
						type: group.type,
						start: index === group.start,
						end: index === group.end - 1,
						groupIndex
					});
				}
			});
			for(let index = 0; index <= shownHand.length; index++){
				for(const [gapIndex, position] of handGapPositions.entries()){
					if(position !== index){
						continue;
					}
					const slot = document.createElement("div");
					slot.className = "hand-drop-slot";
					slot.setAttribute("role", "button");
					slot.setAttribute("tabindex", "0");
					slot.setAttribute("aria-label", "Remove organizing space");
					slot.title = "Remove";
					const removeGap = event => {
						event.preventDefault();
						event.stopPropagation();
						handGapPositions.splice(gapIndex, 1);
						renderCurrentGame();
					};
					slot.addEventListener("click", removeGap);
					slot.addEventListener("keydown", event => {
						if(event.key === "Enter" || event.key === " "){
							removeGap(event);
						}
					});
					handCards.appendChild(slot);
				}
				if(index === shownHand.length){
					break;
				}
				const card = shownHand[index];
				const element = drawCardElement(card, index, enabled, true);
				const meld = groupByIndex.get(index);
				if(meld){
					element.classList.add("meld-card", "meld-" + meld.type);
					if(meld.start){
						element.classList.add("meld-start");
					}
					if(meld.end){
						element.classList.add("meld-end");
					}
					element.dataset.meldGroup = String(meld.groupIndex + 1);
					element.title = "Part of a " + meld.type;
					const accessibleLabel = element.getAttribute("aria-label");
					if(accessibleLabel){
						element.setAttribute(
							"aria-label",
							accessibleLabel + ", part of a " + meld.type
						);
					}
					if(meld.start){
						const indicator = document.createElement("span");
						indicator.className = "card-meld-indicator";
						indicator.textContent = meld.type.toUpperCase();
						element.appendChild(indicator);
					}
				}
				handCards.appendChild(element);
			}
			for(let index = 0; index < 3; index++){
				const slot = document.createElement("div");
				slot.className = "hand-drop-slot hand-drop-slot-temporary hand-drop-slot-reserved";
				slot.setAttribute("aria-hidden", "true");
				handCards.appendChild(slot);
			}
		}
	}
	$("#turnActions").replaceChildren();
	if(mode === "local" && !handVisible && !localGame?.solo && game.status === "playing"){
		const player = currentLocalPlayer();
		const reveal = document.createElement("button");
		reveal.type = "button";
		reveal.textContent = "Reveal " + player.name + "'s hand";
		reveal.addEventListener("click", () => {
			handVisible = true;
			renderLocalGame();
		});
		$("#turnActions").appendChild(reveal);
	}
	if(canAct && !hasDrawn && game.finalTurnsRemaining !== 1){
		infoDiv.textContent = mode === "local"
			? currentLocalPlayer().name + "'s turn — draw from the deck or discard pile."
			: "Your turn — draw from the deck or discard pile.";
	}else if(canAct && hasDrawn && game.finalTurnsRemaining !== 1){
		infoDiv.textContent = "Select a card to discard, or drag cards to rearrange your hand.";
	}
}

function renderLocalGame(){
	if(!localGame){
		return;
	}
	persistLocalGame();
	startDiv.hidden = true;
	gameBoard.hidden = false;
	$("#onlinePlayers").hidden = true;
	$("#returnMenu").hidden = false;
	$("#leaveOnline").hidden = true;
	$("#showScores").hidden = false;
	updateSoloTimer();
	const current = currentLocalPlayer();
	if(localGame.status === "complete"){
		$("#lastTurnBanner").hidden = true;
		const winners = localGame.players.filter(player => localGame.winners.includes(player.id));
		infoDiv.textContent = winners.map(player => player.name).join(" and ") +
			(winners.length === 1 ? " wins!" : " tie for the win!") +
			(localGame.solo
				? " " + current.score.toLocaleString() + " points · " +
					localGame.soloTotalTurns + " turns · " +
					formatElapsedTime(localGame.soloElapsedSeconds) + "."
				: "");
		$("#playAgain").hidden = false;
		renderScoreboard(localGame);
		$("#scoreBoard").hidden = false;
		return;
	}
	$("#playAgain").hidden = true;
	if(!handVisible && !localGame.solo){
		infoDiv.textContent = "Pass the device to " + current.name + ", then reveal their hand.";
	}
	renderGameTable(
		{
			status: localGame.status,
			round: localGame.round,
			useTwosWild: localGame.useTwosWild,
			drawPileCount: localGame.drawPile.length,
			drawPileBackIndexes: localGame.drawPile.slice(-3).map(card =>
				Number(card.id.split("-")[0])
			),
			discardTop: localGame.discardPile[localGame.discardPile.length - 1],
			finalTurnsRemaining: localGame.finalTurnsRemaining,
			currentPlayerLaidDown: current.laidDown,
			currentPlayerName: current.name,
			wentOutPlayerName: localGame.wentOutPlayerName ||
				localGame.players.find(player => player.id === localGame.wentOutPlayerId)?.name ||
				localGame.players.find(player => player.laidDown)?.name
		},
		current.hand,
		localGame.solo || handVisible,
		(localGame.solo || handVisible) && !localGame.hasDrawn,
		localGame.hasDrawn,
		localGame.solo || handVisible
	);
}

function renderOnlineGame(){
	if(!onlineState?.room || !onlineState.game){
		return;
	}
	startDiv.hidden = true;
	gameBoard.hidden = false;
	$("#returnMenu").hidden = true;
	const game = onlineState.game;
	const ownPlayer = game.players.find(player => player.id === onlineCredentials.playerId);
	const currentPlayer = game.players.find(player => player.id === game.currentPlayerId);
	$("#onlinePlayers").hidden = false;
	$("#onlinePlayers").replaceChildren();
	for(const player of game.players){
		const badge = document.createElement("span");
		badge.className = "online-player";
		if(player.id === game.currentPlayerId){
			badge.classList.add("current");
		}
		if(player.laidDown){
			badge.classList.add("laid-down");
		}
		const playerLabel = document.createElement("span");
		playerLabel.textContent = player.name + " · " + player.score + " points";
		badge.appendChild(playerLabel);
		if(onlineCredentials.isHost && player.id !== onlineCredentials.playerId){
			const kick = document.createElement("button");
			kick.className = "kick-player";
			kick.type = "button";
			kick.textContent = "Kick";
			kick.setAttribute("aria-label", "Kick " + player.name + " from the room");
			kick.addEventListener("click", () => void confirmKickPlayer(player));
			badge.appendChild(kick);
		}
		$("#onlinePlayers").appendChild(badge);
	}
	const chatBubble = $("#onlineChatBubble");
	if(onlineState.chat){
		chatBubble.textContent = onlineState.chat.playerName + ": " + onlineState.chat.quote;
		chatBubble.hidden = false;
	}else{
		chatBubble.textContent = "";
		chatBubble.hidden = true;
	}
	$("#onlineChatControls").hidden = game.status !== "playing";
	$("#soloTimer").hidden = true;
	$("#leaveOnline").hidden = false;
	$("#leaveOnline").textContent = onlineCredentials.isHost ? "Close room" : "Leave room";
	const winners = (game.winners || []).map(id => game.players.find(player => player.id === id)?.name).filter(Boolean);
	if(game.status === "complete"){
		if($("#turnDialog").open){
			$("#turnDialog").close();
		}
		lastTurnPromptKey = null;
		$("#lastTurnBanner").hidden = true;
		infoDiv.textContent = winners.join(" and ") + (winners.length === 1 ? " wins!" : " tie for the win!");
		$("#playAgain").hidden = false;
		$("#playAgain").textContent = "Play again";
		renderScoreboard({
			players: game.players,
			round: game.round,
			history: game.history,
			solo: game.solo,
			status: game.status,
			winners: game.winners
		});
		return;
	}
	const hasDrawn = game.hasDrawn && game.currentPlayerId === onlineCredentials.playerId;
	if(game.currentPlayerId !== onlineCredentials.playerId){
		infoDiv.textContent = currentPlayer.name + "'s turn.";
	}
	renderGameTable(
		{
			round: game.round,
			useTwosWild: game.useTwosWild,
			drawPileCount: game.drawPileCount,
			drawPileBackIndexes: game.drawPileBackIndexes,
			discardTop: game.discardTop,
			finalTurnsRemaining: game.finalTurnsRemaining,
			currentPlayerLaidDown: currentPlayer?.laidDown,
			currentPlayerName: currentPlayer?.name,
			wentOutPlayerName: game.wentOutPlayerName ||
				game.players.find(player => player.id === game.wentOutPlayerId)?.name ||
				game.players.find(player => player.laidDown)?.name
		},
		game.hand,
		game.currentPlayerId === onlineCredentials.playerId,
		game.currentPlayerId === onlineCredentials.playerId && !game.hasDrawn,
		hasDrawn,
		true
	);
	if(!ownPlayer){
		showNotice("Your player session is no longer in this room.");
	}
	if(currentPlayer?.laidDown){
		infoDiv.textContent = currentPlayer.name + " has laid down.";
	}
}

function renderScoreboard(game){
	const soloIsInProgress = game.solo && game.status === "playing";
	$("#soloPauseNote").hidden = !soloIsInProgress;
	const celebration = $("#winnerCelebration");
	celebration.replaceChildren();
	const winningPlayers = game.status === "complete"
		? game.players.filter(player => (game.winners || []).includes(player.id))
		: [];
	celebration.hidden = winningPlayers.length === 0;
	if(winningPlayers.length){
		for(const symbol of ["🎉", "✨", "🎊"]){
			const confetti = document.createElement("span");
			confetti.className = "winner-confetti";
			confetti.textContent = symbol;
			confetti.setAttribute("aria-hidden", "true");
			celebration.appendChild(confetti);
		}
		const message = document.createElement("p");
		message.className = "winner-message";
		message.textContent = "Congratulations, " +
			winningPlayers.map(player => player.name).join(" and ") +
			(winningPlayers.length === 1 ? "! You did it!" : "! You're co-champions!");
		celebration.appendChild(message);
		const sparkle = document.createElement("span");
		sparkle.className = "winner-confetti";
		sparkle.textContent = "🥳";
		sparkle.setAttribute("aria-hidden", "true");
		celebration.appendChild(sparkle);
	}
	const table = document.createElement("table");
	const head = document.createElement("thead");
	const header = document.createElement("tr");
	const isSolo = game.solo === true && game.players.length === 1;
	const isFinalMultiplayer = game.status === "complete" && !isSolo;
	const headers = isSolo
		? ["Player", "Turns", "Time", "Score"]
		: isFinalMultiplayer ? ["Place", "Player", "Score"] : ["Player", "Score"];
	for(const text of headers){
		const cell = document.createElement("th");
		cell.textContent = text;
		header.appendChild(cell);
	}
	head.appendChild(header);
	table.appendChild(head);
	const body = document.createElement("tbody");
	const rankedPlayers = isFinalMultiplayer
		? [...game.players].sort((first, second) => first.score - second.score)
		: game.players;
	let previousRank = 0;
	let previousScore = null;
	for(const [index, player] of rankedPlayers.entries()){
		const row = document.createElement("tr");
		if(isFinalMultiplayer){
			const place = document.createElement("td");
			const rank = player.score === previousScore ? previousRank : index + 1;
			place.textContent = rank + (rank === 1 ? "st" : rank === 2 ? "nd" : rank === 3 ? "rd" : "th");
			row.appendChild(place);
			previousRank = rank;
			previousScore = player.score;
		}
		const name = document.createElement("td");
		name.textContent = player.name;
		row.appendChild(name);
		if(isSolo){
			const turns = document.createElement("td");
			turns.textContent = String(
				(game.soloTotalTurns ?? 0) +
				(game.status === "playing" ? game.players[0].turnsThisRound : 0)
			);
			const time = document.createElement("td");
			time.textContent = game.status === "complete"
				? formatElapsedTime(game.soloElapsedSeconds)
				: formatElapsedTime(getSoloElapsedSeconds(game));
			const score = document.createElement("td");
			score.textContent = game.status === "complete"
				? player.score.toLocaleString() + " points"
				: "—";
			row.append(turns, time, score);
		}else{
			const score = document.createElement("td");
			score.textContent = String(player.score);
			row.appendChild(score);
		}
		body.appendChild(row);
	}
	table.appendChild(body);
	$("#scoreTable").replaceChildren(table);

	const history = $("#roundHistory");
	history.replaceChildren();
	const entries = (game.history || []).map(entry => ({
		...entry,
		inProgress: false,
		scores: entry.scores.map(score => ({ ...score }))
	}));
	const previousTotals = new Map();
	for(const entry of entries){
		for(const score of entry.scores){
			const key = score.id || score.name;
			const previousTotal = previousTotals.get(key) || 0;
			if(isSolo){
				if(!Number.isInteger(score.turns) && Number.isFinite(score.score) &&
					score.score >= previousTotal){
					score.turns = score.score - previousTotal;
				}
			}else if(!Number.isFinite(score.points) && Number.isFinite(score.score)){
				score.points = Math.max(0, score.score - previousTotal);
			}
			if(Number.isFinite(score.score)){
				previousTotals.set(key, score.score);
			}
		}
	}
	if(isSolo && game.status === "playing"){
		entries.push({
			round: game.round,
			inProgress: true,
			scores: game.players.map(player => ({
				name: player.name,
				turns: player.turnsThisRound
			}))
		});
	}
	for(const entry of entries){
		const section = document.createElement("section");
		const heading = document.createElement("h3");
		heading.textContent = "Round " + entry.round +
			(entry.inProgress ? " (in progress)" : "") +
			(entry.skipped ? " (skipped for testing)" : "");
		section.appendChild(heading);
		const summary = document.createElement("p");
		summary.textContent = entry.scores.map(score => {
			if(isSolo){
				if(entry.inProgress){
					return score.name + ": " + score.turns + " turns so far";
				}
				return score.name + ": " +
					(Number.isInteger(score.turns) ? score.turns + " turns" : "turn count unavailable");
			}
			return score.name + ": +" + score.points + " points";
		}).join(" · ");
		section.appendChild(summary);
		history.appendChild(section);
	}
}

async function drawFrom(source, insertionIndex = null){
	return drawCardIntoHand(source, insertionIndex);
}

async function drawCardIntoHand(source, insertionIndex){
	if(mode === "online"){
		pendingDrawIndex = insertionIndex;
		if(!sendOnline({ type: "draw", source })){
			pendingDrawIndex = null;
		}
		return;
	}
	if(!localGame || !handVisible || localGame.hasDrawn){
		return;
	}
	try{
		const card = drawCard(localGame, currentLocalPlayer().id, source);
		if(insertionIndex !== null){
			const hand = currentLocalPlayer().hand;
			hand.splice(hand.indexOf(card), 1);
			hand.splice(Math.max(0, Math.min(insertionIndex, hand.length)), 0, card);
		}
		selectedCardId = null;
		renderLocalGame();
	}catch(error){
		showNotice(error.message);
	}
}

async function discardCard(cardId){
	if(pendingAction){
		return;
	}
	const currentGame = mode === "online" ? onlineState?.game : localGame;
	const canDiscardNow = mode === "online"
		? currentGame?.hasDrawn &&
			currentGame.currentPlayerId === onlineCredentials?.playerId
		: currentGame?.hasDrawn === true;
	if(!canDiscardNow){
		return;
	}
	const hand = getOwnHand();
	const card = hand.find(item => item.id === cardId);
	if(!card){
		return;
	}
	const canLay = canLayDown(hand.filter(item => item.id !== cardId), currentGame.round, currentGame.useTwosWild);
	const choice = currentGame.solo
		? { discard: true, layDown: canLay }
		: await askDiscardDecision(canLay);
	if(!choice.discard){
		return;
	}
	const latestGame = mode === "online" ? onlineState?.game : localGame;
	const stillCanDiscard = mode === "online"
		? latestGame?.hasDrawn &&
			latestGame.currentPlayerId === onlineCredentials?.playerId
		: latestGame?.hasDrawn === true;
	if(!stillCanDiscard){
		return;
	}
	const layDown = choice.layDown;
	selectedCardId = null;
	if(mode === "online"){
		sendOnline({ type: "discard", cardId, layDown });
		return;
	}

	const previousRound = localGame.round;
	const previousPlayerId = currentLocalPlayer().id;
	try{
		discardAndEndTurn(localGame, previousPlayerId, cardId, layDown);
		const nextPlayerId = currentLocalPlayer()?.id;
		handVisible = localGame.solo || nextPlayerId === previousPlayerId;
		const roundAdvanced = localGame.round !== previousRound;
		if(localGame.status === "complete" && localGame.solo && !localGame.debugSkipped &&
			!submittedSoloScore){
			submittedSoloScore = true;
			const soloPlayer = localGame.players[0];
			saveSoloScore(soloPlayer, localGame);
			void submitGlobalScore(soloPlayer, localGame);
		}
		renderLocalGame();
		if(localGame.status === "complete" || roundAdvanced){
			if(roundAdvanced && localGame.solo){
				pauseSoloTimer(localGame);
				renderLocalGame();
			}
			renderScoreboard(localGame);
			$("#scoreBoard").hidden = false;
		}
	}catch(error){
		showNotice(error.message);
		renderLocalGame();
	}
}

async function requestRoundSkip(){
	if(mode === "online" && !onlineCredentials?.isHost){
		showNotice("Only the room host can use the round-skip test feature.");
		return;
	}
	if(mode === "online" ? !onlineState?.game : !localGame){
		return;
	}
	$("#decisionTitle").textContent = "Testing: skip this round";
	$("#decisionMessage").textContent =
		"Enter the Worker testing password and choose the round to resume at. Skipped rounds score 0. Choose 15 to skip the rest of the game.";
	$("#layDownHint").textContent = "";
	$("#layDownOption").hidden = true;
	$("#skipPasswordOption").hidden = false;
	$("#skipPassword").value = "";
	const currentRound = mode === "online" ? onlineState.game.round : localGame.round;
	$("#skipTargetRound").min = String(currentRound + 1);
	$("#skipTargetRound").max = String(LAST_ROUND + 1);
	$("#skipTargetRound").value = String(Math.min(currentRound + 1, LAST_ROUND + 1));
	$("#decisionAccept").textContent = "Skip round";
	$("#decisionDeny").textContent = "Cancel";
	$("#decisionDeny").hidden = false;
	const skipRequest = await new Promise(resolve => {
		const finish = accepted => {
			const request = accepted ? {
				password: $("#skipPassword").value.trim(),
				targetRound: Number($("#skipTargetRound").value)
			} : null;
			decisionDialog.close();
			$("#skipPasswordOption").hidden = true;
			$("#skipPassword").value = "";
			resolve(request);
		};
		$("#decisionAccept").onclick = () => finish(true);
		$("#decisionDeny").onclick = () => finish(false);
		decisionDialog.showModal();
		$("#skipPassword").focus();
	});
	if(!skipRequest){
		return;
	}
	const maxRound = LAST_ROUND + 1;
	if(!skipRequest.password || !Number.isInteger(skipRequest.targetRound) ||
		skipRequest.targetRound <= currentRound || skipRequest.targetRound > maxRound){
		showNotice("Choose a destination round after the current round, up to 15 to finish the game.");
		return;
	}
	if(mode === "online"){
		sendOnline({
			type: "testSkipRound",
			password: skipRequest.password,
			targetRound: skipRequest.targetRound
		});
		return;
	}
	try{
		await requestJson("/api/test/authorize-skip", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: skipRequest.password })
		});
		const skippedThrough = skipRequest.targetRound - 1;
		skipRound(localGame, skipRequest.targetRound);
		if(localGame.round !== currentRound || localGame.status === "complete"){
			if(localGame.solo && localGame.status === "playing"){
				pauseSoloTimer(localGame);
			}
			renderLocalGame();
			renderScoreboard(localGame);
			$("#scoreBoard").hidden = false;
		}
		showNotice("Rounds " + currentRound + "–" + skippedThrough + " were skipped with 0 points.");
	}catch(error){
		showNotice(error.message);
	}
}

function sendOnline(message){
	if(!socket || socket.readyState !== WebSocket.OPEN){
		showNotice("The room connection is not ready yet.");
		return false;
	}
	pendingAction = true;
	socket.send(JSON.stringify(message));
	renderOnlineGame();
	return true;
}

function renderRoomLobby(){
	if(!onlineState?.room){
		return;
	}
	gameBoard.hidden = true;
	startDiv.hidden = false;
	localSetup.hidden = true;
	onlineSetup.hidden = true;
	roomLobby.hidden = false;
	$("#scoreBoard").hidden = true;
	$("#playAgain").hidden = true;
	handGapPositions = [];
	handOrder = [];
	$("#onlineChatBubble").hidden = true;
	$("#onlineChatControls").hidden = true;
	$("#leaderboards").hidden = true;
	$("#roomCode").textContent = onlineState.room.code;
	$("#lobbyPlayers").replaceChildren();
	for(const player of onlineState.room.players){
		const item = document.createElement("li");
		const name = document.createElement("span");
		name.textContent = player.name;
		const status = document.createElement("span");
		status.className = player.connected ? "connected" : "disconnected";
		status.textContent = player.connected ? "Connected" : "Connecting…";
		item.append(name, status);
		if(onlineCredentials?.isHost && player.id !== onlineCredentials.playerId){
			const kick = document.createElement("button");
			kick.className = "kick-player";
			kick.type = "button";
			kick.textContent = "Kick";
			kick.setAttribute("aria-label", "Kick " + player.name + " from the room");
			kick.addEventListener("click", () => void confirmKickPlayer(player));
			item.appendChild(kick);
		}
		$("#lobbyPlayers").appendChild(item);
	}
	$("#lobbyStatus").textContent = onlineState.room.useTwosWild ? "2s are wild." : "2s are not wild.";
	const canChangeRoomSettings = Boolean(
		onlineCredentials?.isHost && onlineState.room.status === "waiting"
	);
	$("#onlineTwosWildOption").hidden = !canChangeRoomSettings;
	$("#onlineTwosWild").checked = onlineState.room.useTwosWild;
	$("#onlineTwosWild").disabled = pendingAction || !canChangeRoomSettings;
	$("#leaveRoom").textContent = onlineCredentials?.isHost ? "Close room" : "Leave room";
	$("#startRoom").hidden = !(
		onlineCredentials?.isHost &&
		onlineState.room.status === "waiting" &&
		onlineState.room.players.length >= 2
	);
	infoDiv.textContent = "Online room " + onlineState.room.code + " — waiting for the host to start.";
}

async function confirmKickPlayer(player){
	const accepted = await askDecision(
		"Kick " + player.name + "?",
		"Remove this player from the room? They will be disconnected and cannot rejoin this room.",
		"Kick player",
		"Keep player"
	);
	if(accepted){
		sendOnline({ type: "kick", playerId: player.id });
	}
}

function saveRoomCredentials(credentials){
	onlineCredentials = credentials;
	try{
		sessionStorage.setItem(roomStorageKey, JSON.stringify(credentials));
	}catch(error){
		showNotice("Room connection will not be restored automatically in this browser.");
	}
}

function clearRoomCredentials(){
	onlineCredentials = null;
	onlineState = null;
	try{
		sessionStorage.removeItem(roomStorageKey);
	}catch(error){
		showNotice("Could not clear the saved room session.");
	}
}

function connectRoom(){
	if(!onlineCredentials){
		return;
	}
	manuallyLeavingRoom = false;
	if(socket){
		socket.onclose = null;
		socket.close();
	}
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	const connection = new WebSocket(
		scheme + "//" + location.host + "/api/rooms/" + onlineCredentials.code + "/socket"
	);
	socket = connection;
	connection.addEventListener("open", () => {
		connection.send(JSON.stringify({ type: "authenticate", token: onlineCredentials.token }));
	});
	connection.addEventListener("message", event => {
		let message;
		try{
			message = JSON.parse(event.data);
		}catch(error){
			showNotice("The room sent an invalid update.");
			return;
		}
		if(message.type === "error"){
			pendingAction = false;
			pendingDrawIndex = null;
			manuallyLeavingRoom = false;
			showNotice(message.message);
			if(onlineState?.room){
				onlineState.game && renderOnlineGame();
			}
			return;
		}
		if(message.type === "left"){
			finishRoomExit();
			return;
		}
		if(message.type === "kicked"){
			returnOnlineToMenu();
			showNotice("The room host removed you from the room.");
			return;
		}
		if(message.type !== "state"){
			return;
		}
		const previousGame = onlineState?.game;
		pendingAction = false;
		reconnectAttempts = 0;
		if(pendingDrawIndex !== null && message.game && onlineState?.game){
			const previousOrder = getDisplayedHand(onlineState.game.hand).map(card => card.id);
			const previousIds = new Set(previousOrder);
			const drawnCard = message.game.hand.find(card => !previousIds.has(card.id));
			if(drawnCard){
				previousOrder.splice(
					Math.max(0, Math.min(pendingDrawIndex, previousOrder.length)),
					0,
					drawnCard.id
				);
				handOrder = previousOrder;
			}
			pendingDrawIndex = null;
		}
		onlineState = message;
		if(!message.room){
			clearRoomCredentials();
			showNotice("This room has closed or expired.");
			return;
		}
		if(message.room.status === "waiting"){
			renderRoomLobby();
		}else{
			roomLobby.hidden = true;
			renderOnlineGame();
			const gameCompletedNow = message.game?.status === "complete" &&
				(!previousGame || previousGame.status !== "complete");
			const advancedRound = previousGame &&
				message.game?.round !== previousGame.round &&
				message.game?.round > 3;
			if(gameCompletedNow || advancedRound){
				renderScoreboard(message.game);
				$("#scoreBoard").hidden = false;
			}
			if(message.game?.status === "playing" &&
				message.game.currentPlayerId === onlineCredentials.playerId){
				const turnKey = message.game.round + ":" + message.game.currentPlayerId;
				if(lastTurnPromptKey !== turnKey){
					lastTurnPromptKey = turnKey;
					showTurnDialog();
				}
			}else{
				lastTurnPromptKey = null;
			}
		}
	});
	connection.addEventListener("close", event => {
		if(event.reason === "Room closed by host"){
			void showHostEndedRoom();
			return;
		}
		if(event.reason === "Player left the room"){
			if(onlineCredentials){
				finishRoomExit();
			}
			return;
		}
		if(socket !== connection || manuallyLeavingRoom || !onlineCredentials){
			return;
		}
		if(event.code === 1008 || event.reason.includes("Room closed") ||
			event.reason.includes("expired")){
			clearRoomCredentials();
			roomLobby.hidden = true;
			startDiv.hidden = false;
			$("#leaderboards").hidden = false;
			setMode("online");
			showNotice(event.reason || "The room session is no longer available.");
			return;
		}
		if(reconnectAttempts >= 5){
			showNotice("Could not reconnect to the room. Check your connection and reload to try again.");
			return;
		}
		reconnectAttempts++;
		infoDiv.textContent = "Connection lost — reconnecting to room " + onlineCredentials.code + "…";
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(connectRoom, 1500);
	});
	connection.addEventListener("error", () => {
		showNotice("The online room connection was interrupted.");
	});
}

async function createRoom(){
	const name = $("#onlineName").value.trim();
	if(!name){
		showNotice("Enter your name before creating a room.");
		return;
	}
	try{
		const credentials = await requestJson("/api/rooms", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name })
		});
		reconnectAttempts = 0;
		saveRoomCredentials(credentials);
		connectRoom();
	}catch(error){
		showNotice(error.message);
	}
}

async function joinRoom(){
	const name = $("#onlineName").value.trim();
	const code = $("#roomCodeInput").value.trim().toUpperCase();
	if(!name || !/^[A-Z0-9]{8}$/.test(code)){
		showNotice("Enter your name and the 8-character room code.");
		return;
	}
	try{
		const credentials = await requestJson("/api/rooms/" + code + "/join", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name })
		});
		reconnectAttempts = 0;
		saveRoomCredentials(credentials);
		connectRoom();
	}catch(error){
		showNotice(error.message);
	}
}

async function leaveOnlineRoom(){
	if(!onlineCredentials){
		return;
	}
	if(socket?.readyState !== WebSocket.OPEN){
		showNotice("The room connection is not ready yet. Try again when it reconnects.");
		return;
	}
	const isHost = onlineCredentials.isHost;
	const confirmed = await askDecision(
		isHost ? "Close this room?" : "Leave this room?",
		isHost
			? "Closing the room ends the game for everyone. No one will be able to rejoin this room."
			: "You will be removed from this room and will not be able to rejoin it. The game will continue without you.",
		isHost ? "Close room" : "Leave room",
		isHost ? "Keep room open" : "Stay in room"
	);
	if(!confirmed){
		return;
	}
	manuallyLeavingRoom = true;
	clearTimeout(reconnectTimer);
	clearTimeout(roomExitTimer);
	socket.send(JSON.stringify({ type: isHost ? "close" : "leave" }));
	roomExitTimer = setTimeout(() => {
		if(onlineCredentials){
			manuallyLeavingRoom = false;
			showNotice(isHost
				? "The room did not confirm that it closed. Please try again."
				: "The room did not confirm that you left. Please try again.");
		}
	}, 6000);
}

function returnOnlineToMenu(){
	clearTimeout(reconnectTimer);
	clearTimeout(roomExitTimer);
	manuallyLeavingRoom = true;
	pendingAction = false;
	pendingDrawIndex = null;
	const previousSocket = socket;
	socket = null;
	if(previousSocket && previousSocket.readyState < WebSocket.CLOSING){
		previousSocket.close();
	}
	clearRoomCredentials();
	handOrder = [];
	selectedCardId = null;
	$("#scoreBoard").hidden = true;
	$("#playAgain").hidden = true;
	gameBoard.hidden = true;
	roomLobby.hidden = true;
	startDiv.hidden = false;
	$("#leaderboards").hidden = false;
	setMode("local");
	infoDiv.textContent = "Welcome to 3 to 14";
	refreshLocalScores();
}

function finishRoomExit(){
	returnOnlineToMenu();
}

function showHostEndedRoom(){
	manuallyLeavingRoom = true;
	clearTimeout(reconnectTimer);
	clearTimeout(roomExitTimer);
	pendingAction = false;
	pendingDrawIndex = null;
	const previousSocket = socket;
	socket = null;
	if(previousSocket && previousSocket.readyState < WebSocket.CLOSING){
		previousSocket.close();
	}
	clearRoomCredentials();
	if(decisionDialog.open){
		$("#decisionDeny").click();
	}
	$("#decisionTitle").textContent = "Room closed";
	$("#decisionMessage").textContent = "The host has ended the game. Dismiss this message to return to the main menu.";
	$("#layDownHint").textContent = "";
	$("#layDownOption").hidden = true;
	$("#decisionAccept").textContent = "Return to menu";
	$("#decisionDeny").hidden = true;
	roomEndedDialogOpen = true;
	return new Promise(resolve => {
		$("#decisionAccept").onclick = () => {
			decisionDialog.close();
			roomEndedDialogOpen = false;
			$("#decisionDeny").hidden = false;
			returnOnlineToMenu();
			resolve();
		};
		decisionDialog.showModal();
		$("#decisionAccept").focus();
	});
	roomLobby.hidden = true;
	$("#leaderboards").hidden = false;
	setMode("online");
	infoDiv.textContent = "Choose a room to play online.";
}

async function copyRoomLink(){
	if(!onlineState?.room){
		return;
	}
	const invite = new URL(location.href);
	invite.search = "?room=" + onlineState.room.code;
	try{
		await navigator.clipboard.writeText(invite.toString());
		showNotice("Room invite link copied.");
	}catch(error){
		showNotice("Copy the room code " + onlineState.room.code + " to invite players.");
	}
}

function returnToSetup(){
	if(mode === "online" && onlineCredentials){
		leaveOnlineRoom();
	}
	localGame = null;
	removeSavedLocalGame();
	handVisible = false;
	selectedCardId = null;
	handGapPositions = [];
	lastTurnPromptKey = null;
	if($("#turnDialog").open){
		$("#turnDialog").close();
	}
	$("#scoreBoard").hidden = true;
	gameBoard.hidden = true;
	startDiv.hidden = false;
	roomLobby.hidden = true;
	$("#leaderboards").hidden = false;
	$("#playAgain").hidden = true;
	infoDiv.textContent = "Welcome to 3 to 14";
	setMode("local");
	refreshLocalScores();
}

function initialize(){
	renderPlayerNames();
	refreshLocalScores();
	void loadGlobalScores();
	for(const quote of CHAT_QUOTES){
		const option = document.createElement("option");
		option.value = quote;
		option.textContent = quote;
		$("#chatQuote").appendChild(option);
	}

	document.querySelectorAll(".mode-button").forEach(button => {
		button.addEventListener("click", () => {
			if(button.dataset.mode === "local" && mode === "online" && onlineCredentials){
				void leaveOnlineRoom();
				return;
			}
			setMode(button.dataset.mode);
		});
	});
	$("#playerCount").addEventListener("change", renderPlayerNames);
	$("#leaderboardWildFilter").addEventListener("change", () => {
		renderScoreboards({
			local: readLocalScores(),
			global: globalLeaderboardScores
		});
	});
	$("#roundLabel").addEventListener("click", () => {
		roundLabelClickCount++;
		if(roundLabelClickCount === 13){
			roundLabelClickCount = 0;
			void requestRoundSkip();
		}
	});
	soloTimerInterval = setInterval(updateSoloTimer, 1000);
	$("#startLocal").addEventListener("click", () => {
		const count = Number($("#playerCount").value);
		const names = Array.from($("#playerNames").querySelectorAll("input"), input => input.value.trim());
		if(!Number.isInteger(count) || count < 1 || count > 20 || names.length !== count ||
			names.some(name => !name) || new Set(names.map(name => name.toLocaleLowerCase())).size !== names.length){
			showNotice("Enter a unique name for every player (1–20 players).");
			return;
		}
		try{
			localGame = createGame(
				names.map(name => ({ id: createToken(8), name })),
				$("#twosWild").checked,
				names.length === 1
			);
		}catch(error){
			showNotice(error.message);
			return;
		}
		mode = "local";
		handVisible = localGame.solo;
		selectedCardId = null;
		handGapPositions = [];
		reorderSelectedCardId = null;
		handOrder = [];
		submittedSoloScore = false;
		$("#scoreBoard").hidden = true;
		$("#playAgain").hidden = true;
		renderLocalGame();
	});
	$("#createRoom").addEventListener("click", () => void createRoom());
	$("#joinRoom").addEventListener("click", () => void joinRoom());
	$("#onlineTwosWild").addEventListener("change", () => {
		sendOnline({
			type: "settings",
			useTwosWild: $("#onlineTwosWild").checked
		});
	});
	$("#roomCodeInput").addEventListener("input", event => {
		event.currentTarget.value = event.currentTarget.value.toUpperCase();
	});
	$("#startRoom").addEventListener("click", () => sendOnline({ type: "start" }));
	$("#leaveRoom").addEventListener("click", leaveOnlineRoom);
	$("#leaveOnline").addEventListener("click", leaveOnlineRoom);
	$("#copyRoomLink").addEventListener("click", () => void copyRoomLink());
	$("#showScores").addEventListener("click", () => {
		if(mode === "online" && onlineState?.game){
			renderScoreboard(onlineState.game);
		}else if(localGame){
			pauseSoloTimer(localGame);
			persistLocalGame();
			renderScoreboard(localGame);
		}
		$("#scoreBoard").hidden = false;
	});
	$("#showHowToPlay").addEventListener("click", () => {
		$("#howToPlayDialog").showModal();
		$("#closeHowToPlay").focus();
	});
	$("#closeHowToPlay").addEventListener("click", () => {
		$("#howToPlayDialog").close();
		$("#showHowToPlay").focus();
	});
	$("#closeScores").addEventListener("click", () => {
		closeScoreboard();
	});
	$("#onlineChatControls").addEventListener("submit", event => {
		event.preventDefault();
		sendOnline({ type: "chat", quote: $("#chatQuote").value });
	});
	$("#howToPlayDialog").addEventListener("click", event => {
		if(event.target === $("#howToPlayDialog")){
			$("#howToPlayDialog").close();
		}
	});
	decisionDialog.addEventListener("click", event => {
		if(event.target === decisionDialog){
			if(roomEndedDialogOpen){
				$("#decisionAccept").click();
			}else{
				$("#decisionDeny").click();
			}
		}
	});
	$("#turnDialog").addEventListener("click", () => {
		$("#turnDialog").close();
	});
	document.addEventListener("pointerdown", event => {
		const outsidePopup = popup => {
			if(!popup.open){
				return false;
			}
			const bounds = popup.getBoundingClientRect();
			return event.clientX < bounds.left || event.clientX > bounds.right ||
				event.clientY < bounds.top || event.clientY > bounds.bottom;
		};
		const scoreBoard = $("#scoreBoard");
		if(!scoreBoard.hidden){
			const bounds = scoreBoard.getBoundingClientRect();
			if(event.clientX < bounds.left || event.clientX > bounds.right ||
				event.clientY < bounds.top || event.clientY > bounds.bottom){
				closeScoreboard();
			}
		}
		if(outsidePopup($("#howToPlayDialog"))){
			$("#howToPlayDialog").close();
		}
		if(outsidePopup($("#turnDialog"))){
			$("#turnDialog").close();
		}
		if(outsidePopup(decisionDialog)){
			if(roomEndedDialogOpen){
				$("#decisionAccept").click();
			}else{
				$("#decisionDeny").click();
			}
		}
	});
	$("#playAgain").addEventListener("click", () => {
		if(mode === "online" && onlineState?.game?.status === "complete"){
			sendOnline({ type: "rematch" });
		}else{
			returnToSetup();
		}
	});
	$("#returnMenu").addEventListener("click", async () => {
		const accepted = await askDecision(
			"End this game?",
			"Returning to the main menu will end your current game. It cannot be resumed afterward.",
			"End game",
			"Keep playing"
		);
		if(accepted){
			returnToSetup();
		}
	});
	enablePileDragging(deckTarget, "deck");
	enablePileDragging(discardTarget, "discard");
	deckTarget.addEventListener("click", () => {
		if(suppressPileClick){
			suppressPileClick = false;
			return;
		}
		void drawFrom("deck");
	});
	discardTarget.addEventListener("click", () => {
		if(suppressPileClick){
			suppressPileClick = false;
			return;
		}
		if(selectedCardId !== null){
			void discardCard(selectedCardId);
		}else if(mode === "online" ? onlineState?.game?.hasDrawn : localGame?.hasDrawn){
			return;
		}else{
			void drawFrom("discard");
		}
	});
	decisionDialog.addEventListener("cancel", event => {
		event.preventDefault();
		if(roomEndedDialogOpen){
			$("#decisionAccept").click();
		}else{
			$("#decisionDeny").click();
		}
	});
	window.addEventListener("pagehide", () => {
		if(socket?.readyState === WebSocket.OPEN){
			socket.close();
		}
	});

	const inviteCode = new URLSearchParams(location.search).get("room");
	if(inviteCode && /^[A-Z0-9]{8}$/i.test(inviteCode)){
		$("#roomCodeInput").value = inviteCode.toUpperCase();
		setMode("online");
	}
	try{
		const saved = sessionStorage.getItem(roomStorageKey);
		if(saved){
			const credentials = JSON.parse(saved);
			if(/^[A-Z0-9]{8}$/.test(credentials.code) &&
				typeof credentials.token === "string" &&
				typeof credentials.playerId === "string"){
				onlineCredentials = credentials;
				setMode("online");
				connectRoom();
			}else{
				sessionStorage.removeItem(roomStorageKey);
			}
		}
	}catch(error){
		showNotice("The saved online session could not be restored.");
	}
	if(!onlineCredentials && !inviteCode){
		restoreSavedLocalGame();
	}
}

initialize();
