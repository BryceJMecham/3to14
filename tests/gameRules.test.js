import assert from "node:assert/strict";
import test from "node:test";
import {
	canLayDown,
	cardPoints,
	createGame,
	discardAndEndTurn,
	drawCard,
	findAdjacentMeldGroups,
	getSoloRunElapsedSeconds,
	removePlayerFromGame,
	skipRound,
	soloRunScore,
	unmeldedCardPoints
} from "../og_static_files/gameRules.js";

function card(id, rank, suit = "hearts"){
	return { id, rank, suit };
}

test("the game uses only the decks needed to deal round 14", () => {
	for(const playerCount of [1, 2, 3, 4, 8, 20]){
		const players = Array.from({ length: playerCount }, (_, index) => ({
			id: "player-" + index,
			name: "Player " + index
		}));
		const game = createGame(players);
		const cards = [
			...game.drawPile,
			...game.discardPile,
			...game.players.flatMap(player => player.hand)
		];
		const expectedDecks = Math.ceil(playerCount * 14 / 54);
		assert.equal(cards.length, expectedDecks * 54);
		assert.equal(new Set(cards.map(item => item.id)).size, cards.length);
		assert.deepEqual(
			cards.reduce((counts, item) => {
				const deckIndex = Number(item.id.split("-")[0]);
				counts[deckIndex] = (counts[deckIndex] || 0) + 1;
				return counts;
			}, {}),
			Object.fromEntries(Array.from({ length: expectedDecks }, (_, index) => [index, 54]))
		);
		assert.ok(cards.every(item =>
			/^\d+-(?:(?:hearts|dimonds|spades|clubs)-(?:[2-9]|1[0-4])|joker-[12])$/.test(item.id)
		));
	}
});

test("sets and same-suit runs can cover the entire hand", () => {
	assert.equal(canLayDown([
		card("four-hearts", 4, "hearts"),
		card("four-clubs", 4, "clubs"),
		card("four-spades", 4, "spades"),
		card("five-hearts", 5, "hearts"),
		card("six-hearts", 6, "hearts"),
		card("seven-hearts", 7, "hearts")
	], 3, false), true);
});

test("Aces can be low or high but cannot wrap a run", () => {
	assert.equal(canLayDown([
		card("ace-low", 14),
		card("two", 2),
		card("three", 3)
	], 9, false), true);
	assert.equal(canLayDown([
		card("king", 13),
		card("ace", 14),
		card("two", 2)
	], 9, false), false);
});

test("a wild card can complete one meld but cannot be reused", () => {
	assert.equal(canLayDown([
		card("four", 4),
		card("five", 5),
		card("round-wild", 3)
	], 3, false), true);
	assert.equal(canLayDown([
		card("four", 4),
		card("five", 5),
		card("round-wild", 3),
		card("unmatched", 9, "clubs")
	], 3, false), false);
});

test("2s are wild only when enabled", () => {
	const hand = [card("four", 4), card("five", 5), card("two", 2)];
	assert.equal(canLayDown(hand, 9, false), false);
	assert.equal(canLayDown(hand, 9, true), true);
});

test("wild and leftover point values follow the game rules", () => {
	assert.equal(cardPoints(card("two", 2), 8, false), 5);
	assert.equal(cardPoints(card("two", 2), 8, true), 25);
	assert.equal(cardPoints(card("eight", 8), 8, false), 25);
	assert.equal(cardPoints(card("queen", 12), 8, false), 10);
	assert.equal(cardPoints(card("ace", 14), 8, false), 15);
	assert.equal(cardPoints(card("joker", "Joker", "Joker"), 8, false), 25);
});

test("an empty draw pile shuffles all discards back into the deck", () => {
	const game = createGame([
		{ id: "alice", name: "Alice" },
		{ id: "bob", name: "Bob" }
	]);
	const player = game.players[game.currentIndex];
	const originalCards = [
		card("discard-one", 4, "hearts"),
		card("discard-two", 5, "clubs"),
		card("discard-three", 6, "spades")
	];
	game.drawPile = [];
	game.discardPile = [...originalCards];

	const drawn = drawCard(game, player.id, "deck");

	assert.ok(originalCards.some(item => item.id === drawn.id));
	assert.equal(game.discardPile.length, 0);
	const recycledCards = [
		...game.drawPile,
		...player.hand.filter(item => originalCards.some(cardItem => cardItem.id === item.id))
	];
	assert.equal(recycledCards.length, originalCards.length);
	assert.deepEqual(
		new Set(recycledCards.map(item => item.id)),
		new Set(originalCards.map(item => item.id))
	);
});

test("multiplayer scoring ignores melds and minimizes the points left unmatched", () => {
	assert.equal(unmeldedCardPoints([
		card("run-q", 12, "hearts"),
		card("run-k", 13, "hearts"),
		card("run-a", 14, "hearts"),
		card("set-q1", 12, "clubs"),
		card("set-q2", 12, "spades")
	], 3, false), 20);
	assert.equal(unmeldedCardPoints([
		card("run-4", 4, "hearts"),
		card("run-5", 5, "hearts"),
		card("run-6", 6, "hearts"),
		card("set-q1", 12, "clubs"),
		card("set-q2", 12, "spades"),
		card("set-q3", 12, "dimonds")
	], 3, false), 0);
});

test("adjacent cards are grouped into visible sets and runs", () => {
	assert.deepEqual(findAdjacentMeldGroups([
		card("run-4", 4, "hearts"),
		card("run-5", 5, "hearts"),
		card("run-6", 6, "hearts"),
		card("loose", 9, "clubs"),
		card("set-8a", 8, "clubs"),
		card("set-8b", 8, "hearts"),
		card("set-8c", 8, "spades")
	], 3, false), [
		{ start: 0, end: 3, type: "run" },
		{ start: 4, end: 7, type: "set" }
	]);
});

test("players get one final turn after the first lay-down", () => {
	const game = createGame([
		{ id: "alice", name: "Alice" },
		{ id: "bob", name: "Bob" }
	]);
	game.players.find(player => player.id === "bob").score = 20;
	const alice = game.players[game.currentIndex];
	alice.hand = [
		card("a4", 4, "hearts"),
		card("a5", 4, "clubs"),
		card("a6", 4, "spades")
	];
	const drawnForAlice = drawCard(game, "alice", "deck");
	discardAndEndTurn(game, "alice", drawnForAlice.id, true);
	assert.equal(game.finalTurnsRemaining, 1);
	assert.equal(game.wentOutPlayerId, "alice");
	assert.equal(game.wentOutPlayerName, "Alice");
	assert.equal(game.players[game.currentIndex].id, "bob");

	const drawnForBob = drawCard(game, "bob", "deck");
	game.players.find(player => player.id === "bob").hand = [
		card("queen-heart", 12, "hearts"),
		card("king-heart", 13, "hearts"),
		card("ace-heart", 14, "hearts"),
		card("queen-club", 12, "clubs"),
		drawnForBob
	];
	discardAndEndTurn(game, "bob", drawnForBob.id, false);
	assert.equal(game.round, 4);
	assert.equal(game.history[0].scores.find(score => score.id === "alice").score, 0);
	assert.equal(game.history[0].scores.find(score => score.id === "alice").points, 0);
	assert.equal(game.players.find(player => player.id === "bob").score, 30);
	assert.equal(game.history[0].scores.find(score => score.id === "bob").score, 30);
	assert.equal(game.history[0].scores.find(score => score.id === "bob").points, 10);
});

test("solo runs total the turns spent across completed rounds", () => {
	const game = createGame([{ id: "solo", name: "Solo" }], false, true);
	const player = game.players[0];
	const deckSize = game.drawPile.length + player.hand.length + game.discardPile.length;
	for(const [round, nonLayingTurns] of [[3, 1], [4, 2]]){
		assert.equal(game.round, round);
		for(let turn = 0; turn < nonLayingTurns; turn++){
			const drawn = drawCard(game, "solo", "deck");
			const retained = player.hand.filter(item => item.id !== drawn.id);
			const suits = ["hearts", "clubs", "spades", "dimonds"];
			retained.forEach((cardToKeep, index) => {
				cardToKeep.rank = [2, 6, 9, 12][index];
				cardToKeep.suit = suits[index];
			});
			discardAndEndTurn(game, "solo", drawn.id, false);
		}
		const drawn = drawCard(game, "solo", "deck");
		const retained = player.hand.filter(item => item.id !== drawn.id);
		["hearts", "clubs", "spades", "dimonds"].forEach((suit, index) => {
			if(retained[index]){
				retained[index].rank = 7;
				retained[index].suit = suit;
			}
		});
		discardAndEndTurn(game, "solo", drawn.id, true);
	}
	assert.equal(player.score, 5);
	assert.equal(game.soloTotalTurns, 5);
	assert.equal(game.round, 5);
	assert.equal(game.history[0].scores[0].turns, 2);
	assert.equal(game.history[1].scores[0].turns, 3);
	assert.equal(
	    game.drawPile.length + player.hand.length + game.discardPile.length,
	    deckSize
	);
});

test("solo score rewards fewer turns and faster completion", () => {
	assert.equal(soloRunScore(20, 300), 150000);
	assert.ok(soloRunScore(19, 300) > soloRunScore(20, 300));
	assert.ok(soloRunScore(20, 299) > soloRunScore(20, 300));
	assert.equal(soloRunScore(200, 5000), 0);
});

test("solo run time excludes time spent with the scoreboard open", () => {
	const game = {
		status: "playing",
		soloStartedAt: 1000,
		soloPausedAt: 11000,
		soloPausedMilliseconds: 0,
		soloElapsedSeconds: 10
	};
	assert.equal(getSoloRunElapsedSeconds(game, 21000), 10);
	game.soloPausedMilliseconds = 10000;
	game.soloPausedAt = null;
	assert.equal(getSoloRunElapsedSeconds(game, 21000), 10);
	assert.equal(getSoloRunElapsedSeconds(game, 31000), 20);
});

test("test round skips award zero points and mark solo results ineligible", () => {
	const multiplayer = createGame([
		{ id: "alice", name: "Alice" },
		{ id: "bob", name: "Bob" }
	]);
	const previousScores = multiplayer.players.map(player => player.score);
	drawCard(multiplayer, "alice", "deck");
	skipRound(multiplayer);
	assert.equal(multiplayer.round, 4);
	assert.deepEqual(multiplayer.players.map(player => player.score), previousScores);
	assert.ok(multiplayer.history[0].scores.every(score => score.points === 0));
	assert.equal(multiplayer.history[0].skipped, true);

	const solo = createGame([{ id: "solo", name: "Solo" }], false, true);
	skipRound(solo);
	assert.equal(solo.round, 4);
	assert.equal(solo.debugSkipped, true);
	assert.equal(solo.history[0].scores[0].points, 0);
	while(solo.status === "playing"){
		skipRound(solo);
	}
	assert.equal(solo.players[0].score, 0);
	assert.equal(solo.history.at(-1).scores[0].score, 0);
});

test("test round skips record every skipped round and deal the chosen destination round", () => {
	const game = createGame([
		{ id: "alice", name: "Alice" },
		{ id: "bob", name: "Bob" }
	]);
	const previousScores = game.players.map(player => player.score);

	skipRound(game, 7);

	assert.equal(game.round, 7);
	assert.deepEqual(game.history.map(entry => entry.round), [3, 4, 5, 6]);
	assert.ok(game.history.every(entry =>
		entry.skipped && entry.scores.every(score => score.points === 0)
	));
	assert.deepEqual(game.players.map(player => player.hand.length), [7, 7]);
	assert.deepEqual(game.players.map(player => player.score), previousScores);
});

test("test round skips reject destinations that are not later rounds", () => {
	const game = createGame([{ id: "solo", name: "Solo" }], false, true);
	const originalRound = game.round;

	assert.throws(() => skipRound(game, originalRound), /destination/i);
	assert.throws(() => skipRound(game, 16), /destination/i);
	assert.equal(game.round, originalRound);
	assert.equal(game.history.length, 0);
});

test("skipping to round 15 records round 14 and completes with zero solo points", () => {
	const game = createGame([{ id: "solo", name: "Solo" }], false, true);
	game.round = 12;

	skipRound(game, 15);

	assert.equal(game.status, "complete");
	assert.deepEqual(game.history.map(entry => entry.round), [12, 13, 14]);
	assert.ok(game.history.every(entry =>
		entry.skipped && entry.scores[0].points === 0
	));
	assert.equal(game.players[0].score, 0);
	assert.equal(game.history.at(-1).scores[0].score, 0);
});

test("a completed solo run records first-draw time, total turns, and a high score", () => {
	const game = createGame([{ id: "solo", name: "Solo" }], false, true);
	const player = game.players[0];
	game.round = 14;
	game.soloTotalTurns = 20;
	player.turnsThisRound = 0;
	player.hand = [];
	let now = 100000;
	const originalNow = Date.now;
	Date.now = () => now;
	try{
		const drawn = drawCard(game, "solo", "deck");
		player.hand = [
			...Array.from({ length: 7 }, (_, index) =>
				card("heart-run-" + index, index + 2, "hearts")),
			...Array.from({ length: 7 }, (_, index) =>
				card("club-run-" + index, index + 2, "clubs")),
			{ ...drawn, rank: 9, suit: "hearts" }
		];
		now = 106123;
		discardAndEndTurn(game, "solo", drawn.id, true);
	}finally{
		Date.now = originalNow;
	}
	assert.equal(game.status, "complete");
	assert.equal(game.soloTotalTurns, 21);
	assert.equal(game.soloElapsedSeconds, 6);
	assert.equal(player.score, 178400);
	assert.deepEqual(game.winners, ["solo"]);
});

test("a departing player is removed and their final turn is skipped", () => {
	const game = createGame([
		{ id: "alice", name: "Alice" },
		{ id: "bob", name: "Bob" },
		{ id: "cara", name: "Cara" }
	]);
	const initialDeckSize = game.drawPile.length +
		game.discardPile.length +
		game.players.reduce((total, player) => total + player.hand.length, 0);
	game.currentIndex = 0;
	game.players[0].hand = [
		card("a4", 4, "hearts"),
		card("a5", 4, "clubs"),
		card("a6", 4, "spades")
	];
	const drawnForAlice = drawCard(game, "alice", "deck");
	discardAndEndTurn(game, "alice", drawnForAlice.id, true);
	assert.equal(game.finalTurnsRemaining, 2);

	removePlayerFromGame(game, "bob");
	assert.deepEqual(game.players.map(player => player.id), ["alice", "cara"]);
	assert.equal(game.finalTurnsRemaining, 1);
	assert.equal(game.players[game.currentIndex].id, "cara");

	const drawnForCara = drawCard(game, "cara", "deck");
	discardAndEndTurn(game, "cara", drawnForCara.id);
	assert.equal(game.round, 4);
	assert.deepEqual(game.history[0].scores.map(score => score.id), ["alice", "cara"]);
	assert.equal(
		game.drawPile.length + game.discardPile.length +
			game.players.reduce((total, player) => total + player.hand.length, 0),
		initialDeckSize
	);
});

test("a full game reaches round 14, preserves ties, and recycles cards", () => {
	const game = createGame([
	    { id: "alice", name: "Alice" },
	    { id: "bob", name: "Bob" }
	]);
	const deckSize = () => game.drawPile.length +
	    game.discardPile.length +
	    game.players.reduce((total, player) => total + player.hand.length, 0);
	const initialDeckSize = deckSize();

	while(game.status === "playing"){
	    const player = game.players[game.currentIndex];
	    player.hand = Array.from({ length: game.round }, (_, index) =>
	        card(player.id + "-" + game.round + "-" + index, 7, ["hearts", "clubs", "spades", "dimonds"][index % 4])
	    );
	    const drawn = drawCard(game, player.id, "deck");
	    discardAndEndTurn(game, player.id, drawn.id, true);
	}

	assert.equal(game.history.length, 12);
	assert.equal(game.status, "complete");
	assert.equal(game.players[0].score, 0);
	assert.equal(game.players[1].score, 0);
	assert.deepEqual(new Set(game.winners), new Set(["alice", "bob"]));
	assert.equal(deckSize(), initialDeckSize);
});
