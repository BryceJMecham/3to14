export const MAX_PLAYERS = 20;
export const MAX_BOTS = 3;
export const FIRST_ROUND = 3;
export const LAST_ROUND = 14;
export const SUITS = ["hearts", "dimonds", "spades", "clubs"];
export const BOT_NAMES = [
    "Harry Potter", "Hermione Granger", "Ron Weasley", "Luna Lovegood",
    "Neville Longbottom", "Ginny Weasley", "Fred Weasley", "George Weasley",
    "Cho Chang", "Cedric Diggory", "Aang", "Katara", "Sokka", "Toph",
    "Zuko", "Iroh", "Azula", "Suki", "Ty Lee", "Mai"
];
export const CHAT_QUOTES = [
    "\"Oh, you sweet little thing, you!\"",
    "\"You can't play this game without wild cards.\"",
    "\"That card will gut shot the farm.\"",
    "\"Ya giraffe neck!\"",
    "\"You dirty, rotten, good-for-nothing, garbage can basketball!\""
];
const RANKS = Array.from({ length: 13 }, (_, index) => index + 2);

export function soloRunScore(totalTurns, elapsedSeconds){
    if(!Number.isSafeInteger(totalTurns) || totalTurns < 0 ||
        !Number.isSafeInteger(elapsedSeconds) || elapsedSeconds < 0){
        throw new RangeError("Solo run turns and elapsed time must be non-negative integers.");
    }
    return Math.max(110, 10000 - totalTurns * 10 - elapsedSeconds);
}

export function getSoloRunElapsedSeconds(game, now = Date.now()){
    if(!Number.isFinite(game?.soloStartedAt)){
        return 0;
    }
    if(game.status === "complete" && Number.isSafeInteger(game.soloElapsedSeconds)){
        return game.soloElapsedSeconds;
    }
    const endTime = Number.isFinite(game.soloPausedAt) ? game.soloPausedAt : now;
    return Math.max(0, Math.floor(
        (endTime - game.soloStartedAt - (game.soloPausedMilliseconds || 0)) / 1000
    ));
}

export function randomInteger(max){
    if(!Number.isSafeInteger(max) || max < 1){
        throw new RangeError("The random integer range must be a positive safe integer.");
    }
    const range = 0x100000000;
    const limit = Math.floor(range / max) * max;
    const value = new Uint32Array(1);
    do{
        crypto.getRandomValues(value);
    }while(value[0] >= limit);
    return value[0] % max;
}

export function createToken(bytes = 24){
    const data = new Uint8Array(bytes);
    crypto.getRandomValues(data);
    return Array.from(data, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function shuffle(cards){
    for(let index = cards.length - 1; index > 0; index--){
        const other = randomInteger(index + 1);
        [cards[index], cards[other]] = [cards[other], cards[index]];
    }
    return cards;
}

export function isWild(card, round, useTwosWild){
    return card.rank === "Joker" || card.rank === round || (useTwosWild && card.rank === 2);
}

export function cardPoints(card, round, useTwosWild){
    if(isWild(card, round, useTwosWild)){
        return 25;
    }
    if(card.rank === 14){
        return 15;
    }
    return card.rank >= 10 ? 10 : 5;
}

export function unmeldedCardPoints(hand, round, useTwosWild){
    if(!Array.isArray(hand) || hand.length > 14){
        throw new RangeError("A scoring hand must contain at most 14 cards.");
    }
    if(hand.length === 0){
        return 0;
    }
    if(canLayDown(hand, round, useTwosWild)){
        return 0;
    }

    const meldsByCard = Array.from({ length: hand.length }, () => []);
    const subsetLimit = 1 << hand.length;
    for(let mask = 1; mask < subsetLimit; mask++){
        const cards = [];
        for(let index = 0; index < hand.length; index++){
            if(mask & (1 << index)){
                cards.push(hand[index]);
            }
        }
        if(cards.length < 3 || !isMeld(cards, round, useTwosWild)){
            continue;
        }
        let first = 0;
        while((mask & (1 << first)) === 0){
            first++;
        }
        meldsByCard[first].push(mask);
    }

    const points = hand.map(card => cardPoints(card, round, useTwosWild));
    const memo = new Int16Array(subsetLimit);
    memo.fill(-1);
    memo[0] = 0;
    function minimumPoints(remaining){
        if(memo[remaining] !== -1){
            return memo[remaining];
        }
        let first = 0;
        while((remaining & (1 << first)) === 0){
            first++;
        }
        let best = points[first] + minimumPoints(remaining ^ (1 << first));
        for(const meld of meldsByCard[first]){
            if((meld & remaining) === meld){
                best = Math.min(best, minimumPoints(remaining ^ meld));
            }
        }
        memo[remaining] = best;
        return best;
    }

    return minimumPoints(subsetLimit - 1);
}

export function findAdjacentMeldGroups(hand, round, useTwosWild){
    const bestFrom = Array.from({ length: hand.length + 1 });
    bestFrom[hand.length] = { covered: 0, groups: [] };
    for(let start = hand.length - 1; start >= 0; start--){
        const next = bestFrom[start + 1];
        let best = { covered: next.covered, groups: next.groups };
        for(let end = start + 3; end <= hand.length; end++){
            const cards = hand.slice(start, end);
            if(!isMeld(cards, round, useTwosWild)){
                continue;
            }
            const remainder = bestFrom[end];
            const set = isSet(cards, round, useTwosWild);
            const group = {
                start,
                end,
                type: set ? "set" : "run"
            };
            const candidate = {
                covered: end - start + remainder.covered,
                groups: [group, ...remainder.groups]
            };
            if(candidate.covered > best.covered ||
                (candidate.covered === best.covered &&
                    candidate.groups.length < best.groups.length)){
                best = candidate;
            }
        }
        bestFrom[start] = best;
    }
    return bestFrom[0].groups;
}

function isSet(cards, round, useTwosWild){
    const naturalRanks = new Set(
        cards.filter(card => !isWild(card, round, useTwosWild)).map(card => card.rank)
    );
    return naturalRanks.size <= 1;
}

function isRun(cards, round, useTwosWild){
    const naturalCards = cards.filter(card => !isWild(card, round, useTwosWild));
    if(new Set(naturalCards.map(card => card.suit)).size > 1){
        return false;
    }

    const length = cards.length;
    if(length > 13){
        return false;
    }
    for(let start = 1; start + length - 1 <= 14; start++){
        const occupied = new Set();
        let valid = true;
        for(const card of naturalCards){
            const positions = card.rank === 14 ? [1, 14] : [card.rank];
            const position = positions.find(rank => rank >= start && rank < start + length && !occupied.has(rank));
            if(position === undefined){
                valid = false;
                break;
            }
            occupied.add(position);
        }
        if(valid){
            return true;
        }
    }
    return false;
}

function isMeld(cards, round, useTwosWild){
    return cards.length >= 3 &&
        (isSet(cards, round, useTwosWild) || isRun(cards, round, useTwosWild));
}

export function canLayDown(hand, round, useTwosWild){
    if(hand.length < 3 || hand.length > 14){
        return false;
    }
    const groupMasks = Array.from({ length: hand.length }, () => []);
    const subsetLimit = 1 << hand.length;
    const subsetCards = [];

    for(let mask = 1; mask < subsetLimit; mask++){
        let size = 0;
        const cards = [];
        for(let index = 0; index < hand.length; index++){
            if(mask & (1 << index)){
                size++;
                cards.push(hand[index]);
            }
        }
        if(size >= 3 && isMeld(cards, round, useTwosWild)){
            subsetCards.push(mask);
            for(let index = 0; index < hand.length; index++){
                if(mask & (1 << index)){
                    groupMasks[index].push(mask);
                }
            }
        }
    }

    const memo = new Int8Array(subsetLimit);
    memo.fill(-1);
    memo[0] = 1;
    function cover(remaining){
        if(memo[remaining] !== -1){
            return memo[remaining] === 1;
        }
        let first = 0;
        while((remaining & (1 << first)) === 0){
            first++;
        }
        for(const group of groupMasks[first]){
            if((group & remaining) === group && cover(remaining ^ group)){
                memo[remaining] = 1;
                return true;
            }
        }
        memo[remaining] = 0;
        return false;
    }

    return subsetCards.length > 0 && cover(subsetLimit - 1);
}

function createDeck(playerCount){
    const deckCount = Math.ceil(playerCount * LAST_ROUND / 54);
    const cards = [];
    for(let deckIndex = 0; deckIndex < deckCount; deckIndex++){
        for(const suit of SUITS){
            for(const rank of RANKS){
                cards.push({ id: deckIndex + "-" + suit + "-" + rank, suit, rank });
            }
        }
        cards.push({ id: deckIndex + "-joker-1", suit: "Joker", rank: "Joker" });
        cards.push({ id: deckIndex + "-joker-2", suit: "Joker", rank: "Joker" });
    }
    return shuffle(cards);
}

export function createGame(players, useTwosWild = false, solo = false){
    if(!Array.isArray(players) || players.length < 1 || players.length > MAX_PLAYERS){
        throw new RangeError("A game requires between 1 and 20 players.");
    }
    const bots = players.filter(player => player.isBot === true);
    if(bots.length > MAX_BOTS || bots.some(player =>
        !["easy", "normal", "hard", "extreme"].includes(player.botSkill)
    ) || bots.filter(player => player.botSkill === "extreme").length > 1){
        throw new RangeError("A game can have up to three bots and only one extreme bot.");
    }
    if(solo && players.length !== 1){
        throw new RangeError("Solo games require exactly one player.");
    }
    const game = {
        status: "playing",
        round: FIRST_ROUND,
        useTwosWild: Boolean(useTwosWild),
        solo,
        players: players.map(player => ({
            id: player.id,
            name: player.name,
            isBot: player.isBot === true,
            botSkill: player.isBot === true ? player.botSkill : null,
            score: 0,
            hand: [],
            laidDown: false,
            turnsThisRound: 0
        })),
        history: [],
        drawPile: createDeck(players.length),
        discardPile: [],
        currentIndex: 0,
        hasDrawn: false,
        finalTurnsRemaining: null,
        wentOutPlayerId: null,
        wentOutPlayerName: null,
        soloStartedAt: null,
        soloTotalTurns: 0,
        soloElapsedSeconds: null,
        soloPausedAt: null,
        soloPausedMilliseconds: 0,
        debugSkipped: false
    };
    dealRound(game);
    return game;
}

function dealRound(game){
    for(const player of game.players){
        player.hand = [];
        player.laidDown = false;
        player.turnsThisRound = 0;
    }
    for(let card = 0; card < game.round; card++){
        for(const player of game.players){
            const dealt = game.drawPile.pop();
            if(!dealt){
                throw new Error("The draw pile ran out while dealing.");
            }
            player.hand.push(dealt);
        }
    }
    game.discardPile = [];
    const openingDiscard = game.drawPile.pop();
    if(!openingDiscard){
        throw new Error("The draw pile ran out while starting a round.");
    }
    game.discardPile.push(openingDiscard);
    game.currentIndex = (game.round - FIRST_ROUND) % game.players.length;
    game.hasDrawn = false;
    game.finalTurnsRemaining = null;
    game.wentOutPlayerId = null;
    game.wentOutPlayerName = null;
}

function getCurrentPlayer(game){
    return game.players[game.currentIndex];
}

export function drawCard(game, playerId, source){
    if(game.status !== "playing" || game.hasDrawn || getCurrentPlayer(game).id !== playerId){
        throw new Error("It is not this player's draw.");
    }
    let card;
    if(source === "discard"){
        card = game.discardPile.pop();
        if(!card){
            throw new Error("The discard pile is empty.");
        }
    }else if(source === "deck"){
        if(game.drawPile.length === 0 && game.discardPile.length > 0){
            game.drawPile = shuffle(game.discardPile.splice(0));
        }
        card = game.drawPile.pop();
        if(!card){
            throw new Error("The draw pile is empty.");
        }
    }else{
        throw new Error("Choose either the deck or discard pile.");
    }
    getCurrentPlayer(game).hand.push(card);
    game.hasDrawn = true;
    if(game.solo && game.soloStartedAt === null){
        game.soloStartedAt = Date.now();
    }
    return card;
}

function botHandValue(hand, round, useTwosWild, skill){
    const synergyMultiplier = skill === "extreme" ? 1.4 : skill === "hard" ? 1.2 : 1;
    let value = 0;
    for(let index = 0; index < hand.length; index++){
        const card = hand[index];
        value += isWild(card, round, useTwosWild)
            ? 18
            : -cardPoints(card, round, useTwosWild);
        for(let otherIndex = 0; otherIndex < index; otherIndex++){
            const other = hand[otherIndex];
            const cardIsWild = isWild(card, round, useTwosWild);
            const otherIsWild = isWild(other, round, useTwosWild);
            if(cardIsWild || otherIsWild){
                value += (cardIsWild && otherIsWild ? 5 : 8) * synergyMultiplier;
            }else if(card.rank === other.rank){
                value += 17 * synergyMultiplier;
            }else if(card.suit === other.suit){
                const aceHighDistance = Math.abs(card.rank - other.rank);
                const firstRank = card.rank === 14 ? 1 : card.rank;
                const secondRank = other.rank === 14 ? 1 : other.rank;
                const distance = Math.min(
                    aceHighDistance,
                    Math.abs(firstRank - secondRank)
                );
                if(distance === 1){
                    value += 18 * synergyMultiplier;
                }else if(distance === 2){
                    value += 9 * synergyMultiplier;
                }
            }
        }
    }
    return value;
}

function bestBotDiscard(hand, round, useTwosWild, skill, checkLayDown = true){
    const choices = [];
    for(const [index, card] of hand.entries()){
        const remaining = hand.filter((_, cardIndex) => cardIndex !== index);
        const layDown = checkLayDown && canLayDown(remaining, round, useTwosWild);
        const score = layDown
            ? Number.MAX_SAFE_INTEGER
            : botHandValue(remaining, round, useTwosWild, skill);
        choices.push({ card, layDown, score });
    }
    return choices;
}

function bestBotFinalTurnDiscard(hand, round, useTwosWild){
    return hand.map((card, index) => {
        const remaining = hand.filter((_, cardIndex) => cardIndex !== index);
        const layDown = canLayDown(remaining, round, useTwosWild);
        return {
            card,
            layDown,
            score: -unmeldedCardPoints(remaining, round, useTwosWild)
        };
    });
}

function estimateUnknownDraws(hand, knownCards = []){
    const unavailableCards = [...hand, ...knownCards];
    const candidates = [];
    for(const suit of SUITS){
        for(let rank = 2; rank <= 14; rank++){
            candidates.push({
                id: "estimate-" + suit + "-" + rank,
                rank,
                suit
            });
        }
    }
    candidates.push(
        { id: "estimate-joker-1", rank: "Joker", suit: "Joker" },
        { id: "estimate-joker-2", rank: "Joker", suit: "Joker" }
    );
    return candidates.filter(candidate =>
        !unavailableCards.some(card => card.rank === candidate.rank &&
            (candidate.rank === "Joker" || card.suit === candidate.suit))
    );
}

export function chooseBotMove(game, playerId){
    const player = game.players.find(candidate => candidate.id === playerId);
    if(!player?.isBot || game.status !== "playing"){
        throw new Error("A bot move requires an active bot player.");
    }
    const hand = player.hand;
    if(game.hasDrawn){
        const choices = game.finalTurnsRemaining !== null
            ? bestBotFinalTurnDiscard(hand, game.round, game.useTwosWild)
            : bestBotDiscard(
                hand, game.round, game.useTwosWild, player.botSkill || "normal"
            );
        if(!choices.length){
            throw new Error("The bot has no card to discard.");
        }
        let choice;
        if(player.botSkill === "easy"){
            const laydownChoices = choices.filter(candidate => candidate.layDown);
            const availableChoices = laydownChoices.length ? laydownChoices : choices;
            choice = availableChoices[randomInteger(availableChoices.length)];
        }else{
            choice = choices.reduce((best, candidate) =>
                candidate.score > best.score ? candidate : best
            );
        }
        return {
            source: null,
            discardCardId: choice.card.id,
            layDown: choice.layDown
        };
    }

    const skill = player.botSkill || "normal";
    const topDiscard = game.discardPile.at(-1);
    const closingTurn = game.finalTurnsRemaining !== null;
    const getDiscardChoices = closingTurn
        ? bestBotFinalTurnDiscard
        : bestBotDiscard;
    const discardChoices = topDiscard
        ? getDiscardChoices(
            [...hand, topDiscard],
            game.round,
            game.useTwosWild,
            skill
        )
        : null;
    const discardChoice = discardChoices?.reduce((best, candidate) =>
        candidate.score > best.score ? candidate : best
    );
    const unknownDraws = estimateUnknownDraws(hand, [topDiscard].filter(Boolean));
    const deckScores = unknownDraws.map(candidate =>
        Math.max(...getDiscardChoices(
            [...hand, candidate],
            game.round,
            game.useTwosWild,
            skill,
            false
        ).map(choice => choice.score))
    ).sort((first, second) => first - second);

    let takeDiscard = false;
    if(discardChoice && skill === "easy"){
        takeDiscard = randomInteger(2) === 0;
    }else if(discardChoice && deckScores.length){
        const percentile = skill === "extreme" ? 0.95 : skill === "hard" ? 0.8 : 0.5;
        const expectedScore = deckScores[Math.floor(
            (deckScores.length - 1) * percentile
        )];
        takeDiscard = closingTurn
            ? discardChoice.score > expectedScore
            : discardChoice.score >= expectedScore;
    }
    return {
        source: takeDiscard ? "discard" : "deck",
        discardCardId: null,
        layDown: false
    };
}

export function playBotTurn(game, playerId){
    const player = game.players.find(candidate => candidate.id === playerId);
    if(!player?.isBot){
        throw new Error("Only a bot can take an automated turn.");
    }
    if(!game.hasDrawn){
        const move = chooseBotMove(game, playerId);
        drawCard(game, playerId, move.source);
    }
    const discard = chooseBotMove(game, playerId);
    discardAndEndTurn(game, playerId, discard.discardCardId, discard.layDown);
}

function finishRound(game){
    const roundScores = [];
    for(const player of game.players){
        let pointsGained = 0;
        if(!game.solo && !player.laidDown){
            pointsGained = unmeldedCardPoints(player.hand, game.round, game.useTwosWild);
            player.score += pointsGained;
        }
        roundScores.push({
            id: player.id,
            name: player.name,
            score: player.score,
            points: pointsGained,
            turns: player.turnsThisRound
        });
    }
    game.history.push({ round: game.round, scores: roundScores });
    if(game.round === LAST_ROUND){
        game.status = "complete";
        if(game.solo){
            const player = game.players[0];
            game.soloTotalTurns = (game.soloTotalTurns || 0) + player.turnsThisRound;
            game.soloElapsedSeconds = getSoloRunElapsedSeconds(game);
            player.score = soloRunScore(game.soloTotalTurns, game.soloElapsedSeconds);
            game.history[game.history.length - 1].scores[0].score = player.score;
            game.winners = [player.id];
        }else{
            const lowestScore = Math.min(...game.players.map(player => player.score));
            game.winners = game.players.filter(player => player.score === lowestScore).map(player => player.id);
        }
        return;
    }
    if(game.solo){
        game.soloTotalTurns = (game.soloTotalTurns || 0) + game.players[0].turnsThisRound;
    }
    advanceToNextRound(game);
}

function advanceToNextRound(game, nextRound = game.round + 1){
    for(const player of game.players){
        game.drawPile.push(...player.hand);
    }
    game.drawPile.push(...game.discardPile);
    shuffle(game.drawPile);
    game.round = nextRound;
    dealRound(game);
}

export function skipRound(game, targetRound = game.round + 1){
    if(game.status !== "playing"){
        throw new Error("Only an active game can skip a round.");
    }
    if(!Number.isInteger(targetRound) || targetRound <= game.round ||
        targetRound > LAST_ROUND + 1){
        throw new RangeError("Choose a destination after the current round and no later than round 15.");
    }
    game.debugSkipped = true;
    if(game.solo){
        game.soloTotalTurns = (game.soloTotalTurns || 0) + game.players[0].turnsThisRound;
    }
    for(let round = game.round; round < targetRound; round++){
        game.history.push({
            round,
            skipped: true,
            scores: game.players.map(player => ({
                id: player.id,
                name: player.name,
                score: player.score,
                points: 0,
                turns: round === game.round ? player.turnsThisRound : 0
            }))
        });
    }
    if(targetRound === LAST_ROUND + 1){
        game.status = "complete";
        if(game.solo){
            game.soloElapsedSeconds = getSoloRunElapsedSeconds(game);
            game.players[0].score = 0;
            game.history[game.history.length - 1].scores[0].score = 0;
            game.winners = [game.players[0].id];
        }else{
            const lowestScore = Math.min(...game.players.map(player => player.score));
            game.winners = game.players.filter(player => player.score === lowestScore).map(player => player.id);
        }
        return;
    }
    advanceToNextRound(game, targetRound);
}

export function discardAndEndTurn(game, playerId, cardId, layDown = false){
    const player = getCurrentPlayer(game);
    if(game.status !== "playing" || !game.hasDrawn || player.id !== playerId){
        throw new Error("It is not this player's discard.");
    }
    const cardIndex = player.hand.findIndex(card => card.id === cardId);
    if(cardIndex === -1){
        throw new Error("That card is not in this player's hand.");
    }
    const remainingHand = player.hand.filter((_, index) => index !== cardIndex);
    const eligibleToLayDown = canLayDown(remainingHand, game.round, game.useTwosWild);
    if(layDown && !eligibleToLayDown){
        throw new Error("This hand is not a complete set or run.");
    }
    game.discardPile.push(player.hand.splice(cardIndex, 1)[0]);
    player.turnsThisRound++;
    game.hasDrawn = false;

    if(game.solo){
        if(layDown){
            player.laidDown = true;
            player.score += player.turnsThisRound;
            finishRound(game);
        }
        return;
    }

    const finalTurnWasActive = game.finalTurnsRemaining !== null;
    if(layDown){
        player.laidDown = true;
    }
    if(!finalTurnWasActive && layDown){
        game.wentOutPlayerId = player.id;
        game.wentOutPlayerName = player.name;
        game.finalTurnsRemaining = game.players.filter(other => other.id !== player.id && !other.laidDown).length;
    }else if(finalTurnWasActive){
        game.finalTurnsRemaining--;
    }

    if(game.finalTurnsRemaining === 0){
        finishRound(game);
        return;
    }
    for(let offset = 1; offset <= game.players.length; offset++){
        const index = (game.currentIndex + offset) % game.players.length;
        if(!game.players[index].laidDown){
            game.currentIndex = index;
            return;
        }
    }
    finishRound(game);
}

export function removePlayerFromGame(game, playerId){
    if(game.status !== "playing"){
        throw new Error("Players can only leave an active game.");
    }
    const playerIndex = game.players.findIndex(player => player.id === playerId);
    if(playerIndex < 0){
        throw new Error("That player is not in this game.");
    }
    const player = game.players[playerIndex];
    const currentPlayerId = getCurrentPlayer(game).id;
    game.drawPile.push(...player.hand);
    shuffle(game.drawPile);
    game.players.splice(playerIndex, 1);
    if(game.finalTurnsRemaining !== null && !player.laidDown){
        game.finalTurnsRemaining--;
    }
    if(game.players.length === 0){
        game.status = "complete";
        game.winners = [];
        game.currentIndex = 0;
        game.hasDrawn = false;
        return;
    }

    if(currentPlayerId === playerId){
        game.currentIndex = playerIndex % game.players.length;
        game.hasDrawn = false;
    }else{
        game.currentIndex = game.players.findIndex(other => other.id === currentPlayerId);
    }
    if(game.finalTurnsRemaining === 0 || game.players.every(other => other.laidDown)){
        finishRound(game);
        return;
    }
    for(let offset = 0; offset < game.players.length; offset++){
        const index = (game.currentIndex + offset) % game.players.length;
        if(!game.players[index].laidDown){
            game.currentIndex = index;
            return;
        }
    }
    finishRound(game);
}
