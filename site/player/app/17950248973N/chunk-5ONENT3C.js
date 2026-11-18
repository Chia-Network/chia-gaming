import {
  CalpokerOutcome,
  projectCalpokerFinalDisplay,
  useCalpokerHand
} from "./chunk-3D4PUFI5.js";
import {
  formatSpacepokerAmount,
  formatSpacepokerMojos
} from "./chunk-RA4YWXGF.js";
import {
  handProposal_default,
  isValidKrunkStake
} from "./chunk-2727RITZ.js";
import {
  __commonJS,
  __toESM,
  isSettlementOutcome,
  require_jsx_runtime,
  require_react
} from "./chunk-ZODP5B7L.js";

// ../shared/protocol-constants/constants.json
var require_constants = __commonJS({
  "../shared/protocol-constants/constants.json"(exports, module) {
    module.exports = {
      gameTimeoutBlocks: {
        min: 3,
        max: 100
      },
      sessionTimeoutBlocks: {
        min: 3,
        max: 30
      }
    };
  }
});

// ../shared/protocol-constants/index.cjs
var require_protocol_constants = __commonJS({
  "../shared/protocol-constants/index.cjs"(exports, module) {
    module.exports = require_constants();
  }
});

// ../shared/bencodex/index.js
var require_bencodex = __commonJS({
  "../shared/bencodex/index.js"(exports, module) {
    var textEncoder = new TextEncoder();
    var textDecoder = new TextDecoder();
    var DEFAULT_LIMITS = Object.freeze({
      maxDepth: 512,
      maxValues: 1e5
    });
    var BencodexError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "BencodexError";
      }
    };
    function concat(parts) {
      const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
      }
      return out;
    }
    function ascii(s) {
      return textEncoder.encode(s);
    }
    function encodeBytes(bytes) {
      return concat([ascii(String(bytes.byteLength)), ascii(":"), bytes]);
    }
    function encodeText(text) {
      const bytes = textEncoder.encode(text);
      return concat([ascii("u"), ascii(String(bytes.byteLength)), ascii(":"), bytes]);
    }
    function keySortValue(key) {
      if (typeof key === "string") {
        return { kind: 1, bytes: textEncoder.encode(key), encoded: encodeText(key) };
      }
      if (key instanceof Uint8Array) {
        return { kind: 0, bytes: key, encoded: encodeBytes(key) };
      }
      throw new BencodexError("dictionary keys must be strings or Uint8Array");
    }
    function compareBytes(a, b) {
      const len = Math.min(a.byteLength, b.byteLength);
      for (let i = 0; i < len; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
      }
      return a.byteLength - b.byteLength;
    }
    function isPlainObject(value) {
      if (value === null || typeof value !== "object") return false;
      if (Array.isArray(value) || value instanceof Uint8Array || value instanceof Map) return false;
      return Object.getPrototypeOf(value) === Object.prototype;
    }
    function encode2(value) {
      if (value === null) return ascii("n");
      if (typeof value === "boolean") return ascii(value ? "t" : "f");
      if (typeof value === "bigint") return ascii(`i${value.toString()}e`);
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw new BencodexError("numbers must be safe integers");
        return ascii(`i${BigInt(value).toString()}e`);
      }
      if (typeof value === "string") return encodeText(value);
      if (value instanceof Uint8Array) return encodeBytes(value);
      if (Array.isArray(value)) {
        return concat([ascii("l"), ...value.map((item) => encode2(item)), ascii("e")]);
      }
      if (value instanceof Map || isPlainObject(value)) {
        const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
        const encodedEntries = entries.map(([key, item]) => {
          const sortKey = keySortValue(key);
          return { sortKey, value: encode2(item) };
        });
        encodedEntries.sort((a, b) => {
          if (a.sortKey.kind !== b.sortKey.kind) return a.sortKey.kind - b.sortKey.kind;
          return compareBytes(a.sortKey.bytes, b.sortKey.bytes);
        });
        const parts = [ascii("d")];
        for (const entry of encodedEntries) {
          parts.push(entry.sortKey.encoded, entry.value);
        }
        parts.push(ascii("e"));
        return concat(parts);
      }
      throw new BencodexError(`unsupported value type: ${typeof value}`);
    }
    var Decoder = class {
      constructor(input, limits) {
        if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 0) {
          throw new BencodexError("maxDepth must be a non-negative safe integer");
        }
        if (!Number.isSafeInteger(limits.maxValues) || limits.maxValues < 0) {
          throw new BencodexError("maxValues must be a non-negative safe integer");
        }
        this.input = input instanceof Uint8Array ? input : new Uint8Array(input);
        this.offset = 0;
        this.maxDepth = limits.maxDepth;
        this.maxValues = limits.maxValues;
        this.values = 0;
      }
      eof() {
        return this.offset >= this.input.byteLength;
      }
      peek() {
        if (this.eof()) throw new BencodexError("unexpected end of input");
        return this.input[this.offset];
      }
      take() {
        const b = this.peek();
        this.offset++;
        return b;
      }
      readUntil(byte) {
        const start = this.offset;
        while (!this.eof() && this.input[this.offset] !== byte) {
          this.offset++;
        }
        if (this.eof()) throw new BencodexError(`missing delimiter 0x${byte.toString(16)}`);
        const out = this.input.slice(start, this.offset);
        this.offset++;
        return out;
      }
      readLength(prefixAlreadyRead) {
        const start = prefixAlreadyRead ? this.offset - 1 : this.offset;
        while (!this.eof()) {
          const b = this.input[this.offset];
          if (b === 58) break;
          if (b < 48 || b > 57) throw new BencodexError("invalid byte string length");
          this.offset++;
        }
        if (this.eof()) throw new BencodexError("missing ':' in byte string");
        const raw = textDecoder.decode(this.input.slice(start, this.offset));
        if (raw.length > 1 && raw.startsWith("0")) throw new BencodexError("invalid byte string length");
        this.offset++;
        const len = Number(raw);
        if (!Number.isSafeInteger(len) || len < 0) throw new BencodexError("invalid byte string length");
        return len;
      }
      readBytes(prefixAlreadyRead = false) {
        const len = this.readLength(prefixAlreadyRead);
        if (this.input.byteLength < this.offset + len) throw new BencodexError("unexpected end of byte string");
        const out = this.input.slice(this.offset, this.offset + len);
        this.offset += len;
        return out;
      }
      readInteger() {
        const rawBytes = this.readUntil(101);
        const raw = textDecoder.decode(rawBytes);
        if (!/^(?:0|-?[1-9][0-9]*)$/.test(raw)) {
          throw new BencodexError("invalid integer encoding");
        }
        try {
          return BigInt(raw);
        } catch {
          throw new BencodexError(`cannot parse integer: ${raw}`);
        }
      }
      consumeValue(depth) {
        if (depth > this.maxDepth) {
          throw new BencodexError("maximum value nesting depth exceeded");
        }
        this.values++;
        if (this.values > this.maxValues) {
          throw new BencodexError("maximum value count exceeded");
        }
      }
      readValue(depth = 0) {
        this.consumeValue(depth);
        const tag2 = this.take();
        if (tag2 === 110) return null;
        if (tag2 === 116) return true;
        if (tag2 === 102) return false;
        if (tag2 === 105) return this.readInteger();
        if (tag2 === 117) return textDecoder.decode(this.readBytes());
        if (tag2 >= 48 && tag2 <= 57) return this.readBytes(true);
        if (tag2 === 108) {
          const items = [];
          while (this.peek() !== 101) {
            items.push(this.readValue(depth + 1));
          }
          this.offset++;
          return items;
        }
        if (tag2 === 100) {
          const items = /* @__PURE__ */ new Map();
          while (this.peek() !== 101) {
            this.consumeValue(depth + 1);
            const keyTag = this.take();
            let key;
            if (keyTag === 117) key = textDecoder.decode(this.readBytes());
            else if (keyTag >= 48 && keyTag <= 57) key = this.readBytes(true);
            else throw new BencodexError("dictionary key must be bytes or text");
            items.set(key, this.readValue(depth + 1));
          }
          this.offset++;
          return items;
        }
        throw new BencodexError(`unexpected byte: 0x${tag2.toString(16)}`);
      }
    };
    function decode2(bytes, limits = DEFAULT_LIMITS) {
      const decoder = new Decoder(bytes, limits);
      const value = decoder.readValue();
      if (!decoder.eof()) throw new BencodexError("trailing bytes after value");
      return value;
    }
    function isDictionary(value) {
      return value instanceof Map;
    }
    function getText(map, key) {
      const value = map.get(key);
      return typeof value === "string" ? value : void 0;
    }
    function getBoolean(map, key) {
      const value = map.get(key);
      return typeof value === "boolean" ? value : void 0;
    }
    function getBytes(map, key) {
      const value = map.get(key);
      return value instanceof Uint8Array ? value : void 0;
    }
    function getInteger(map, key) {
      const value = map.get(key);
      return typeof value === "bigint" ? value : void 0;
    }
    module.exports = {
      BencodexError,
      decode: decode2,
      encode: encode2,
      getBoolean,
      getBytes,
      getInteger,
      getText,
      isDictionary
    };
  }
});

// src/lib/session/saveEnvelope.ts
var DURABLE_APPLICATION_STATE_SCHEMA = "chia-gaming-application-state";
var DURABLE_APPLICATION_STATE_VERSION = 5n;
var MAX_DURABLE_REJECTION_TRANSPORTS = 8;
function isFailedHandshakeCheckpoint(session) {
  return session?.phase === "live" && session.live.disposition === "outbound-reject" && session.presentation.channelStatus?.state === "Failed";
}
function retainRejectionTransport(records, tombstone) {
  return [
    ...records.filter(
      (record) => record.peerId !== tombstone.peerId || record.sessionId !== tombstone.sessionId
    ),
    structuredClone(tombstone)
  ].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_DURABLE_REJECTION_TRANSPORTS);
}
function rejectionTransportKey(peerId, sessionId) {
  return JSON.stringify([peerId, sessionId]);
}

// src/lib/gamePackage.tsx
var import_react = __toESM(require_react(), 1);
function defineGamePackage(feature, HandProposalForm7, mount) {
  return {
    ...feature,
    createHand: (init) => feature.createHand(init),
    restoreHand: (savedState) => feature.restoreHand(savedState),
    decodeProposalParameters: feature.proposalParameters.decode,
    encodeProposalParameters: (parameters) => feature.proposalParameters.encode(parameters),
    render: (view) => mount.render(view),
    renderHandProposalForm: (props) => (0, import_react.createElement)(HandProposalForm7, {
      ...props,
      ref: props.ref,
      initialValues: props.initialValues
    })
  };
}

// ../games/calpoker/ui/serialize.ts
function isCardArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "bigint" && item >= 0n && item < 52n) && new Set(value).size === value.length;
}
function isDisplaySnapshot(value) {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value;
  return typeof snapshot.gameState === "string" && (snapshot.winner === null || typeof snapshot.winner === "string") && isCardArray(snapshot.playerBestHandCardIds) && isCardArray(snapshot.opponentBestHandCardIds) && isCardArray(snapshot.playerHaloCardIds) && isCardArray(snapshot.opponentHaloCardIds) && typeof snapshot.playerDisplayText === "string" && typeof snapshot.opponentDisplayText === "string";
}
function isBigintArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "bigint");
}
function isCalpokerOutcome(value) {
  if (typeof value !== "object" || value === null) return false;
  const outcome = value;
  return (outcome.my_win_outcome === "win" || outcome.my_win_outcome === "lose" || outcome.my_win_outcome === "tie") && isCardArray(outcome.my_cards) && isCardArray(outcome.their_cards) && isCardArray(outcome.my_final_hand) && isCardArray(outcome.their_final_hand) && isCardArray(outcome.my_used_cards) && isCardArray(outcome.their_used_cards) && isBigintArray(outcome.my_hand_value) && isBigintArray(outcome.their_hand_value);
}
function isCalpokerHandState(value) {
  if (typeof value !== "object" || value === null) return false;
  const state = value;
  if (!isCardArray(state.playerHand) || !isCardArray(state.opponentHand)) return false;
  if (state.playerHand.length !== state.opponentHand.length) {
    return false;
  }
  if ((/* @__PURE__ */ new Set([...state.playerHand, ...state.opponentHand])).size !== state.playerHand.length * 2) {
    return false;
  }
  if (state.cardSelections !== void 0 && (!isCardArray(state.cardSelections) || state.cardSelections.length > 4 || state.cardSelections.some((card) => !state.playerHand.includes(card)))) {
    return false;
  }
  return typeof state.perPlayerStake === "bigint" && state.perPlayerStake > 0n && typeof state.moveNumber === "bigint" && state.moveNumber >= 0n && state.moveNumber <= 3n && typeof state.isPlayerTurn === "boolean" && typeof state.iStarted === "boolean" && (state.settlementOutcome === null || isSettlementOutcome(state.settlementOutcome)) && (state.displaySnapshot === void 0 || isDisplaySnapshot(state.displaySnapshot)) && (state.outcome === void 0 || isCalpokerOutcome(state.outcome));
}
function initialState(init) {
  const member = init.members[0];
  if (member.playerAContribution <= 0n || member.playerAContribution !== member.playerBContribution || member.readableParameters.toBigInt() !== member.playerAContribution) {
    throw new Error("California Poker requires matching approved and readable contributions");
  }
  return {
    perPlayerStake: member.playerAContribution,
    playerHand: [],
    opponentHand: [],
    cardSelections: [],
    moveNumber: 0n,
    isPlayerTurn: member.ourTurn,
    iStarted: !member.ourTurn,
    settlementOutcome: null
  };
}
function cardsFromReadable(readable, iStarted) {
  const lists = readable.toList().map((list) => list.toList().map((card) => card.toBigInt()));
  return iStarted ? { playerHand: lists[1], opponentHand: lists[0] } : { playerHand: lists[0], opponentHand: lists[1] };
}
function selectedCardsToBitfield(selectedCards, hand) {
  return hand.reduce(
    (bitfield, cardId, index) => selectedCards.includes(cardId) ? bitfield | 1n << BigInt(index) : bitfield,
    0n
  );
}
function isCalpokerOutcomeReadable(readable) {
  const result = readable.toList();
  return result.length === 6 && result[3].toList().length > 0 && result[4].toList().length > 0;
}
function assertCalpokerOutcomeStage(current) {
  if (current.moveNumber < 2n) {
    throw new Error(
      `Calpoker final readable arrived before local selections were submitted (moveNumber=${current.moveNumber})`
    );
  }
  if (current.playerHand.length !== 8 || current.opponentHand.length !== 8 || current.cardSelections?.length !== 4 || !current.cardSelections.every((card) => current.playerHand.includes(card))) {
    throw new Error("Calpoker final readable arrived without complete local hand selections");
  }
}
function calpokerOutcomeFromState(current, readable, iStarted) {
  return new CalpokerOutcome(
    iStarted,
    selectedCardsToBitfield(current.cardSelections ?? [], current.playerHand),
    iStarted ? current.opponentHand : current.playerHand,
    iStarted ? current.playerHand : current.opponentHand,
    readable
  );
}
function calpokerOutcomeShape(outcome) {
  return {
    my_win_outcome: outcome.my_win_outcome,
    my_cards: outcome.my_cards,
    their_cards: outcome.their_cards,
    my_final_hand: outcome.my_final_hand,
    their_final_hand: outcome.their_final_hand,
    my_used_cards: outcome.my_used_cards,
    their_used_cards: outcome.their_used_cards,
    my_hand_value: outcome.my_hand_value,
    their_hand_value: outcome.their_hand_value
  };
}
function reduceCalpokerFeatureState(current, event) {
  if (event.type === "game-message") {
    return { ...current, ...cardsFromReadable(event.readable, current.iStarted) };
  }
  if (isCalpokerOutcomeReadable(event.readable)) {
    assertCalpokerOutcomeStage(current);
    const outcome = calpokerOutcomeFromState(current, event.readable, current.iStarted);
    const display = projectCalpokerFinalDisplay(outcome);
    return {
      ...current,
      playerHand: display.playerCards,
      opponentHand: display.opponentCards,
      cardSelections: [],
      isPlayerTurn: true,
      outcome: calpokerOutcomeShape(outcome),
      displaySnapshot: {
        gameState: "final",
        winner: display.winner,
        playerBestHandCardIds: display.playerBestHandCardIds,
        opponentBestHandCardIds: display.opponentBestHandCardIds,
        playerHaloCardIds: display.playerHaloCardIds,
        opponentHaloCardIds: display.opponentHaloCardIds,
        playerDisplayText: display.playerDisplayText,
        opponentDisplayText: display.opponentDisplayText
      }
    };
  }
  return {
    ...current,
    ...current.moveNumber === 1n && !current.iStarted ? cardsFromReadable(event.readable, current.iStarted) : {},
    isPlayerTurn: true
  };
}
function reduceCalpokerHandState(current, event) {
  if (event.type === "hand-ended") {
    return { ...current, isPlayerTurn: false, settlementOutcome: event.outcome };
  }
  if (event.type === "move-readable" || event.type === "message-readable") {
    return reduceCalpokerFeatureState(current, {
      type: event.type === "move-readable" ? "opponent-moved" : "game-message",
      readable: event.readable
    });
  }
  return current;
}
function calpokerHandFromState(initial) {
  let state = initial;
  return {
    getState: () => state,
    receive: (update) => {
      state = reduceCalpokerHandState(state, update);
    },
    update: (reducer) => {
      state = reducer(state);
    }
  };
}
function createCalpokerHand(init) {
  if (init.members.length !== 1) {
    throw new Error("California Poker requires one game");
  }
  return calpokerHandFromState(initialState(init));
}
function restoreCalpokerHand(savedState) {
  if (!isCalpokerHandState(savedState)) {
    throw new Error("Cannot restore California Poker hand: saved state is invalid");
  }
  return calpokerHandFromState(savedState);
}

// ../games/calpoker/ui/formatting.ts
var TRILLION = 1000000000000n;
function formatCalpokerAmount(mojos) {
  if (mojos < 1000000n) return `${mojos} MOJO`;
  const whole = mojos / TRILLION;
  const frac = mojos % TRILLION;
  if (frac === 0n) return `${whole} XCH`;
  return `${whole}.${frac.toString().padStart(12, "0").replace(/0+$/, "")} XCH`;
}
function formatCalpokerMojos(mojos) {
  const abs = mojos < 0n ? -mojos : mojos;
  if (abs < 100000000n) return `${mojos.toLocaleString()} mojos`;
  const sign = mojos < 0n ? "-" : "";
  const whole = abs / TRILLION;
  const frac = (abs % TRILLION).toString().padStart(12, "0").slice(0, 4);
  return `${sign}${whole.toLocaleString()}.${frac} XCH`;
}

// ../games/calpoker/ui/handProposal.ts
var calpokerProposalParameters = {
  decode: (value) => typeof value === "bigint" && value > 0n ? value : null,
  encode: (value) => value
};
var registration = {
  displayName: "California Poker",
  createHand: createCalpokerHand,
  restoreHand: restoreCalpokerHand,
  proposalParameters: calpokerProposalParameters,
  describeHandProposal(handProposal) {
    const stake = calpokerProposalParameters.decode(handProposal.parameters);
    if (stake === null) {
      throw new Error("California Poker proposal parameters are invalid");
    }
    return `Stake ${formatCalpokerMojos(stake)} each`;
  }
};
var handProposal_default2 = registration;

// ../games/calpoker/ui/handProposalForm.tsx
var import_react3 = __toESM(require_react());

// ../games/calpoker/ui/AmountInput.tsx
var import_react2 = __toESM(require_react());
var import_jsx_runtime = __toESM(require_jsx_runtime());
function mojosToXch(mojos) {
  const value = mojos.toString().padStart(13, "0");
  const whole = value.slice(0, -12).replace(/^0+/, "") || "0";
  const frac = value.slice(-12).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
function parseAmount(raw, unit) {
  if (/^\s*$/.test(raw)) return 0n;
  const value = raw.trim();
  if (unit === "mojo") return /^\d+$/.test(value) ? BigInt(value) : null;
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  if (frac.length > 12) return null;
  return BigInt(whole + frac.padEnd(12, "0"));
}
function AmountInput({
  valueMojos,
  onChange,
  maxMojos,
  onUseMax,
  disabled,
  label,
  exceedsLabel,
  onKeyDown
}) {
  const [unit, setUnit] = (0, import_react2.useState)("mojo");
  const [rawInput, setRawInput] = (0, import_react2.useState)(() => valueMojos.toString());
  const lastExternalMojos = (0, import_react2.useRef)(valueMojos);
  (0, import_react2.useEffect)(() => {
    if (valueMojos === lastExternalMojos.current) return;
    lastExternalMojos.current = valueMojos;
    setRawInput(unit === "xch" ? mojosToXch(valueMojos) : valueMojos.toString());
  }, [unit, valueMojos]);
  const parsed = parseAmount(rawInput, unit);
  const valid = parsed !== null && parsed > 0n;
  const exceeds = valid && maxMojos != null && parsed > maxMojos;
  const changeUnit = (0, import_react2.useCallback)(
    (next) => {
      if (next === unit) return;
      const current = parseAmount(rawInput, unit);
      setUnit(next);
      if (current !== null) setRawInput(next === "xch" ? mojosToXch(current) : current.toString());
    },
    [rawInput, unit]
  );
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-col items-center gap-1 text-center", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-wrap items-center justify-center gap-2", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "text-xs text-canvas-text", children: label }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex rounded-md border border-canvas-border overflow-hidden text-xs", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => changeUnit("mojo"), className: `px-2 py-0.5 transition-colors ${unit === "mojo" ? "bg-canvas-bg-active font-semibold" : "hover:bg-canvas-bg-hover"}`, children: "mojo" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => changeUnit("xch"), className: `px-2 py-0.5 transition-colors border-l border-canvas-border ${unit === "xch" ? "bg-canvas-bg-active font-semibold" : "hover:bg-canvas-bg-hover"}`, children: "XCH" })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "input",
      {
        type: "text",
        inputMode: unit === "xch" ? "decimal" : "numeric",
        value: rawInput,
        onChange: (event) => {
          const raw = event.target.value;
          setRawInput(raw);
          const next = parseAmount(raw, unit);
          if (next !== null && next > 0n) {
            lastExternalMojos.current = next;
            onChange(next);
          }
        },
        onKeyDown,
        disabled,
        className: `w-full rounded border px-2 py-1 text-center text-sm bg-canvas-bg-subtle text-canvas-text-contrast outline-none ${!valid && rawInput.trim() !== "" ? "border-alert-solid" : "border-canvas-line"}`
      }
    ),
    exceeds && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-wrap items-center justify-center gap-2 text-xs text-alert-text", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: exceedsLabel }),
      onUseMax && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "button",
        {
          type: "button",
          onClick: () => {
            if (maxMojos == null) return;
            lastExternalMojos.current = maxMojos;
            setRawInput(unit === "xch" ? mojosToXch(maxMojos) : maxMojos.toString());
            onChange(maxMojos);
            onUseMax();
          },
          className: "underline font-medium hover:text-alert-text-contrast transition-colors",
          children: [
            "Use max (",
            unit === "xch" ? `${mojosToXch(maxMojos)} XCH` : `${maxMojos} mojos`,
            ")"
          ]
        }
      )
    ] })
  ] });
}

// ../games/calpoker/ui/handProposalForm.tsx
var import_jsx_runtime2 = __toESM(require_jsx_runtime());
var HandProposalForm = (0, import_react3.forwardRef)(function HandProposalForm2({ disabled, maxPerHandMojos, defaultContribution, initialValues, onSubmit }, ref) {
  const initialAmount = initialValues?.parameters ?? defaultContribution;
  const [amount, setAmount] = (0, import_react3.useState)(initialAmount);
  (0, import_react3.useImperativeHandle)(ref, () => ({
    getProposal: () => amount > 0n && (maxPerHandMojos === null || amount <= maxPerHandMojos) ? {
      ok: true,
      parameters: amount
    } : { ok: false, error: "Enter a positive stake within the available reserve." }
  }));
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    AmountInput,
    {
      valueMojos: amount,
      onChange: setAmount,
      maxMojos: maxPerHandMojos,
      onUseMax: maxPerHandMojos != null && maxPerHandMojos > 0n ? () => setAmount(maxPerHandMojos) : void 0,
      disabled,
      label: "Per-player stake",
      exceedsLabel: "Exceeds available reserve.",
      onKeyDown: (event) => {
        if (event.key === "Enter") onSubmit();
      }
    }
  );
});

// ../games/calpoker/ui/play.tsx
var import_react4 = __toESM(require_react());
var import_jsx_runtime3 = __toESM(require_jsx_runtime());
var Calpoker = (0, import_react4.lazy)(() => import("./Calpoker-XKFM6JRL.js"));
function snapshotView(snapshot) {
  if (!snapshot) return void 0;
  return {
    ...snapshot,
    playerBestHandCardIds: snapshot.playerBestHandCardIds.map(String),
    opponentBestHandCardIds: snapshot.opponentBestHandCardIds.map(String),
    playerHaloCardIds: snapshot.playerHaloCardIds.map(String),
    opponentHaloCardIds: snapshot.opponentHaloCardIds.map(String)
  };
}
function snapshotModel(snapshot) {
  return {
    ...snapshot,
    playerBestHandCardIds: snapshot.playerBestHandCardIds.map(BigInt),
    opponentBestHandCardIds: snapshot.opponentBestHandCardIds.map(BigInt),
    playerHaloCardIds: snapshot.playerHaloCardIds.map(BigInt),
    opponentHaloCardIds: snapshot.opponentHaloCardIds.map(BigInt)
  };
}
function outcomeView(outcome) {
  if (!outcome) return void 0;
  return {
    my_win_outcome: outcome.my_win_outcome,
    my_cards: outcome.my_cards.map(String),
    their_cards: outcome.their_cards.map(String),
    my_final_hand: outcome.my_final_hand.map(String),
    their_final_hand: outcome.their_final_hand.map(String),
    my_used_cards: outcome.my_used_cards.map(String),
    their_used_cards: outcome.their_used_cards.map(String),
    my_hand_value: outcome.my_hand_value.map(String),
    their_hand_value: outcome.their_hand_value.map(String)
  };
}
function CalpokerLiveMount(props) {
  const { view } = props;
  const state = view.hand.getState();
  const hand = useCalpokerHand(view);
  const handleGameLog = (0, import_react4.useCallback)(
    (lines) => {
      if (view.frozen) return;
      view.appendGameLog(`California Poker ${formatCalpokerAmount(state.perPlayerStake)}`);
      lines.forEach(view.appendGameLog);
      view.appendGameLog("");
    },
    [view, state.perPlayerStake]
  );
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
    Calpoker,
    {
      outcome: outcomeView(hand.outcome),
      moveNumber: String(hand.moveNumber),
      playerNumber: state.iStarted ? 1 : 2,
      playerHand: hand.playerHand.map(String),
      opponentHand: hand.opponentHand.map(String),
      cardSelections: hand.cardSelections.map(String),
      setCardSelections: (next) => hand.setCardSelections((previous) => {
        const view2 = previous.map(String);
        return (typeof next === "function" ? next(view2) : next).map(BigInt);
      }),
      setHandOrder: (player, opponent) => hand.setHandOrder(player.map(BigInt), opponent?.map(BigInt)),
      handleMakeMove: hand.handleMakeMove,
      onGameLog: handleGameLog,
      onSnapshotChange: (snapshot) => hand.saveDisplaySnapshot(snapshotModel(snapshot)),
      initialSnapshot: snapshotView(hand.initialDisplaySnapshot),
      myName: view.myName,
      opponentName: view.opponentName,
      terminalOutcome: hand.terminalOutcome,
      frozen: view.frozen,
      error: null
    }
  );
}
var play = {
  render(view) {
    return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(CalpokerLiveMount, { view });
  }
};

// ../games/spacepoker/ui/serialize.ts
function isForfeitOutcome(outcome) {
  return outcome === "forfeited_skipped_reveal" || outcome === "forfeited_we_accepted";
}
var HANDLERS = /* @__PURE__ */ new Set([0n, 1n, 2n, 3n, 4n, 5n, 6n]);
var TERMINALS = /* @__PURE__ */ new Set([
  "none",
  "settled",
  "revealed",
  "conceded-by-you",
  "conceded-by-opponent",
  "folded-by-you",
  "folded-by-opponent",
  "won-by-opponent-failure"
]);
var DISPLAY_MODES = /* @__PURE__ */ new Set(["xch", "mojos", "units"]);
var ACTIONS = /* @__PURE__ */ new Set(["check", "raise", "call", "fold", "concede", "reveal", "failed"]);
function isCardPair(value) {
  return Array.isArray(value) && value.length === 2 && value.every((card) => typeof card === "bigint" && card >= 0n && card < 52n);
}
function isGameState(value) {
  if (typeof value !== "object" || value === null) return false;
  const state = value;
  if (typeof state.handler !== "bigint" || !HANDLERS.has(state.handler) || typeof state.myTurn !== "boolean" || typeof state.N !== "bigint") {
    return false;
  }
  const validN = state.handler <= 1n && state.N === 4n || (state.handler === 2n || state.handler === 3n) && state.N >= 1n && state.N <= 4n || state.handler === 4n && state.N === 1n || state.handler === 5n && (state.N === 0n || state.N === 1n) || state.handler === 6n && state.N >= 1n && state.N <= 4n;
  return validN && (!isTerminalHandler(state.handler) || state.myTurn === false);
}
function isTerminalHandler(handler) {
  return handler === 5n || handler === 6n;
}
function isHistory(value) {
  return Array.isArray(value) && value.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const item = entry;
    const hasUnits = typeof item.units === "bigint" && item.units > 0n;
    return (item.player === "you" || item.player === "opponent") && typeof item.action === "string" && ACTIONS.has(item.action) && (item.action === "raise" ? hasUnits : item.units === void 0) && (item.endsStreet === void 0 || item.action === "check" && typeof item.endsStreet === "boolean");
  });
}
function isOutcome(value) {
  if (typeof value !== "object" || value === null) return false;
  const outcome = value;
  const bigints2 = (cards2) => Array.isArray(cards2) && cards2.every((card) => typeof card === "bigint");
  const cards = (value2) => Array.isArray(value2) && value2.every((card) => typeof card === "bigint" && card >= 0n && card < 52n);
  return typeof outcome.result === "bigint" && cards(outcome.playerHandCards) && bigints2(outcome.playerHandEval) && (outcome.opponentHandCards === null || cards(outcome.opponentHandCards)) && (outcome.opponentHandEval === null || bigints2(outcome.opponentHandEval)) && outcome.opponentHandCards === null === (outcome.opponentHandEval === null);
}
function isSpacepokerHandState(value) {
  if (typeof value !== "object" || value === null) return false;
  const state = value;
  if (typeof state.perPlayerStake !== "bigint" || state.perPlayerStake <= 0n || !isGameState(state.gameState) || state.playerHoleCards !== null && !isCardPair(state.playerHoleCards) || state.opponentHoleCards !== null && !isCardPair(state.opponentHoleCards) || !Array.isArray(state.communityCards) || state.communityCards.length !== 5 || !state.communityCards.every(
    (card) => card === null || typeof card === "bigint" && card >= 0n && card < 52n
  )) {
    return false;
  }
  if (typeof state.terminalState !== "string" || !TERMINALS.has(state.terminalState)) return false;
  const terminalHandlerMatches = state.terminalState === "none" || state.terminalState === "settled" && state.gameState.handler === 6n || state.terminalState === "revealed" && state.gameState.handler === 5n || (state.terminalState === "conceded-by-you" || state.terminalState === "conceded-by-opponent") && state.gameState.handler === 5n || (state.terminalState === "folded-by-you" || state.terminalState === "folded-by-opponent") && state.gameState.handler === 6n || state.terminalState === "won-by-opponent-failure" && state.gameState.handler === 6n;
  if (!terminalHandlerMatches) return false;
  if (state.terminalState === "revealed" && state.outcome === null) return false;
  return typeof state.playerBoost === "boolean" && (state.opponentBoost === null || typeof state.opponentBoost === "boolean") && typeof state.halfPot === "bigint" && state.halfPot >= 0n && typeof state.lastRaise === "bigint" && state.lastRaise >= 0n && typeof state.iRaisedLast === "boolean" && isHistory(state.handHistory) && (state.outcome === null || isOutcome(state.outcome)) && (state.coinTossIOpen === null || typeof state.coinTossIOpen === "boolean") && typeof state.unitSizeMojos === "bigint" && state.unitSizeMojos > 0n && (state.settlementOutcome === null || isSettlementOutcome(state.settlementOutcome)) && typeof state.displayMode === "string" && DISPLAY_MODES.has(state.displayMode);
}
function initialState2(init, unitSizeMojos) {
  const member = init.members[0];
  if (member.playerAContribution <= 0n || member.playerAContribution !== member.playerBContribution) {
    throw new Error("Space Poker requires equal positive approved contributions");
  }
  return {
    perPlayerStake: member.playerAContribution,
    gameState: { handler: 0n, myTurn: member.ourTurn, N: 4n },
    playerHoleCards: null,
    playerBoost: false,
    opponentHoleCards: null,
    opponentBoost: null,
    communityCards: [null, null, null, null, null],
    halfPot: 1n,
    lastRaise: 0n,
    iRaisedLast: false,
    handHistory: [],
    outcome: null,
    terminalState: "none",
    coinTossIOpen: null,
    unitSizeMojos,
    settlementOutcome: null,
    displayMode: unitSizeMojos >= 1000000n ? "xch" : "mojos"
  };
}
function parseReadable(readable) {
  return readable.toList();
}
function tag(items) {
  if (items.length === 0) return null;
  return new TextDecoder().decode(items[0].atom);
}
function appendHistory(current, entry) {
  return { ...current, handHistory: [...current.handHistory, entry] };
}
function withLocalTerminalAction(current, action) {
  const last = current.handHistory[current.handHistory.length - 1];
  const replacesTerminalAction = last?.player === "you" && (last.action === "fold" || last.action === "concede" || last.action === "reveal" || last.action === "failed");
  if (last?.player === "you" && last.action === action) return current;
  return {
    ...current,
    handHistory: replacesTerminalAction ? [...current.handHistory.slice(0, -1), { player: "you", action }] : [...current.handHistory, { player: "you", action }]
  };
}
function reduceSpacepokerSettlementState(current, outcome) {
  const voluntary = outcome === "accept_settlement" || outcome === "we_accepted";
  if (isForfeitOutcome(outcome)) {
    return withLocalTerminalAction(
      {
        ...current,
        gameState: {
          handler: 6n,
          myTurn: false,
          N: current.gameState.N >= 1n ? current.gameState.N : 1n
        },
        outcome: null,
        terminalState: "folded-by-you"
      },
      "fold"
    );
  }
  if (outcome === "opponent_timed_out" && current.terminalState === "none") {
    if (current.outcome !== null && current.outcome.result > 0n) {
      return appendHistory(
        {
          ...current,
          gameState: { handler: 5n, myTurn: false, N: 1n },
          terminalState: "conceded-by-opponent"
        },
        { player: "opponent", action: "concede" }
      );
    }
    return appendHistory(
      {
        ...current,
        gameState: {
          handler: 6n,
          myTurn: false,
          N: current.gameState.N >= 1n ? current.gameState.N : 1n
        },
        terminalState: "won-by-opponent-failure"
      },
      { player: "opponent", action: "failed" }
    );
  }
  if (current.terminalState === "revealed" && current.outcome !== null) {
    return {
      ...current,
      gameState: { ...current.gameState, myTurn: false }
    };
  }
  if (voluntary && current.terminalState !== "none") {
    return {
      ...current,
      gameState: { ...current.gameState, myTurn: false }
    };
  }
  if (voluntary && (current.gameState.handler === 3n || current.gameState.handler === 4n)) {
    const player = outcome === "we_accepted" || current.gameState.myTurn ? "you" : "opponent";
    const action = current.gameState.handler === 3n ? "fold" : "concede";
    return appendHistory(
      {
        ...current,
        gameState: action === "fold" ? { handler: 6n, myTurn: false, N: current.gameState.N } : { handler: 5n, myTurn: false, N: 0n },
        terminalState: action === "fold" ? player === "you" ? "folded-by-you" : "folded-by-opponent" : player === "you" ? "conceded-by-you" : "conceded-by-opponent"
      },
      { player, action }
    );
  }
  return {
    ...current,
    gameState: {
      handler: 6n,
      myTurn: false,
      N: current.gameState.N >= 1n ? current.gameState.N : 1n
    },
    outcome: null,
    terminalState: "settled"
  };
}
function bigints(program) {
  return program.toList().map((item) => item.toBigInt());
}
function placeCards(current, position, cards) {
  const communityCards = [...current.communityCards];
  const start = position === 3n ? 0 : position === 2n ? 3 : 4;
  cards.forEach((card, index) => {
    communityCards[start + index] = card;
  });
  return { ...current, communityCards };
}
function outcomeFrom(playerCards, playerEval, opponentCards, opponentEval, result) {
  return {
    result: result.toBigInt(),
    playerHandCards: bigints(playerCards),
    playerHandEval: bigints(playerEval),
    opponentHandCards: bigints(opponentCards),
    opponentHandEval: bigints(opponentEval)
  };
}
function reduceSpacepokerFeatureState(current, event) {
  const items = parseReadable(event.readable);
  const readableTag = tag(items);
  if (!readableTag && event.type === "opponent-moved") {
    return { ...current, gameState: { handler: 1n, myTurn: true, N: 4n } };
  }
  if (event.type === "game-message") {
    if (readableTag === "deal" && items.length >= 4) {
      return {
        ...current,
        playerHoleCards: [items[1].toBigInt(), items[2].toBigInt()],
        playerBoost: items[3].toBigInt() !== 0n,
        coinTossIOpen: items.length >= 5 ? items[4].toBigInt() !== 0n : current.coinTossIOpen
      };
    }
    if (readableTag === "cards" && items.length > 1) {
      const cards = items.slice(1).map((item) => item.toBigInt());
      return placeCards(current, current.gameState.N, cards);
    }
    if (readableTag === "call" && items.length > 3) {
      const nextN = items[2].toBigInt();
      return nextN > 1n ? placeCards(
        current,
        nextN - 1n,
        items.slice(3).map((item) => item.toBigInt())
      ) : current;
    }
    throw new Error(`Unsupported Space Poker game message readable tag: ${readableTag}`);
  }
  const units = (value) => value / current.unitSizeMojos;
  if (readableTag === "deal" || readableTag === "pong") {
    return {
      ...current,
      playerHoleCards: items.length >= 3 ? [items[1].toBigInt(), items[2].toBigInt()] : current.playerHoleCards,
      playerBoost: items.length >= 4 ? items[3].toBigInt() !== 0n : current.playerBoost,
      coinTossIOpen: readableTag === "pong" ? true : items.length >= 5 ? items[4].toBigInt() !== 0n : current.coinTossIOpen,
      gameState: { handler: 2n, myTurn: true, N: 4n }
    };
  }
  if (readableTag === "open" || readableTag === "raise") {
    const raise = units(items[1].toBigInt());
    let next = {
      ...current,
      halfPot: units(items[2].toBigInt()),
      lastRaise: raise,
      iRaisedLast: false,
      gameState: { handler: 3n, myTurn: true, N: current.gameState.N }
    };
    if (readableTag === "open" && items.length > 3) {
      if (current.gameState.N === 4n) {
        next = {
          ...next,
          playerHoleCards: [items[3].toBigInt(), items[4].toBigInt()],
          playerBoost: items[5].toBigInt() !== 0n
        };
      } else {
        next = placeCards(
          next,
          current.gameState.N,
          items.slice(3).map((item) => item.toBigInt())
        );
      }
    }
    return appendHistory(next, {
      player: "opponent",
      action: raise > 0n ? "raise" : "check",
      ...raise > 0n ? { units: raise } : {}
    });
  }
  if (readableTag === "call") {
    const nextN = items[2].toBigInt();
    const action = current.lastRaise > 0n ? "call" : "check";
    let next = {
      ...current,
      halfPot: units(items[1].toBigInt()),
      lastRaise: 0n,
      gameState: nextN === 1n ? { handler: 4n, myTurn: true, N: 1n } : { handler: 2n, myTurn: true, N: nextN - 1n }
    };
    if (nextN === 1n && items.length >= 12) {
      const playerCards = bigints(items[3]);
      const opponentCards = bigints(items[5]);
      next = {
        ...next,
        opponentHoleCards: [opponentCards[0], opponentCards[1]],
        opponentBoost: items[6].toBigInt() !== 0n,
        communityCards: playerCards.slice(2, 7),
        outcome: outcomeFrom(items[7], items[8], items[9], items[10], items[11])
      };
    } else if (nextN > 1n && items.length > 3) {
      next = placeCards(
        next,
        nextN - 1n,
        items.slice(3).map((item) => item.toBigInt())
      );
    }
    return appendHistory(next, {
      player: "opponent",
      action,
      ...action === "check" ? { endsStreet: true } : {}
    });
  }
  if (readableTag === "end" && items.length >= 6) {
    return appendHistory(
      {
        ...current,
        gameState: { handler: 5n, myTurn: false, N: 0n },
        opponentHoleCards: items.length > 7 ? [items[6].toBigInt(), items[7].toBigInt()] : current.opponentHoleCards,
        opponentBoost: items.length > 8 ? items[8].toBigInt() !== 0n : current.opponentBoost,
        outcome: outcomeFrom(items[1], items[2], items[3], items[4], items[5]),
        terminalState: "revealed"
      },
      { player: "opponent", action: "reveal" }
    );
  }
  throw new Error(`Unsupported Space Poker move readable tag: ${readableTag}`);
}
function reduceSpacepokerHandState(current, event) {
  if (event.type === "hand-ended") {
    const settled = event.outcome ? reduceSpacepokerSettlementState(current, event.outcome) : current;
    return {
      ...settled,
      gameState: { ...settled.gameState, myTurn: false },
      settlementOutcome: event.outcome
    };
  }
  if (event.type !== "move-readable" && event.type !== "message-readable") return current;
  const readableEvent = {
    type: event.type === "move-readable" ? "opponent-moved" : "game-message",
    readable: event.readable
  };
  return reduceSpacepokerFeatureState(current, readableEvent);
}
function spacepokerHandFromState(initial) {
  let state = initial;
  return {
    getState: () => state,
    receive: (update) => {
      state = reduceSpacepokerHandState(state, update);
    },
    update: (reducer) => {
      state = reducer(state);
    }
  };
}
function createSpacepokerHand(init) {
  if (init.members.length !== 1) {
    throw new Error("Space Poker hand requires one game");
  }
  const readableParameters = init.members[0].readableParameters.toList();
  if (readableParameters.length !== 2) {
    throw new Error("Space Poker hand requires two readable parameters");
  }
  const stackSize = readableParameters[0].toBigInt();
  const betUnitMojos = readableParameters[1].toBigInt();
  if (stackSize <= 0n || betUnitMojos <= 0n || stackSize * betUnitMojos !== init.members[0].playerAContribution) {
    throw new Error("Space Poker hand received invalid resolved parameters");
  }
  return spacepokerHandFromState(initialState2(init, betUnitMojos));
}
function restoreSpacepokerHand(savedState) {
  if (!isSpacepokerHandState(savedState)) {
    throw new Error("Cannot restore Space Poker hand: saved state is invalid");
  }
  return spacepokerHandFromState(savedState);
}

// ../games/spacepoker/ui/unitSize.ts
var spacepokerProposalParameters = {
  decode(value) {
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "bigint" || value[0] < 0n || typeof value[1] !== "bigint" || value[1] <= 0n) {
      return null;
    }
    return { stackSize: value[0], betUnitMojos: value[1] };
  },
  encode: (params) => [params.stackSize, params.betUnitMojos]
};

// ../games/spacepoker/ui/handProposal.ts
var registration2 = {
  displayName: "Space Poker",
  createHand: createSpacepokerHand,
  restoreHand: restoreSpacepokerHand,
  proposalParameters: spacepokerProposalParameters,
  describeHandProposal(handProposal) {
    const params = spacepokerProposalParameters.decode(handProposal.parameters);
    if (!params) {
      throw new Error("Space Poker proposal parameters are invalid");
    }
    if (params.stackSize === 0n) {
      return `No limit \xB7 minimum raise ${formatSpacepokerMojos(params.betUnitMojos)}`;
    }
    const stake = params.stackSize * params.betUnitMojos;
    return `Stake ${formatSpacepokerMojos(stake)} each \xB7 minimum raise ${formatSpacepokerMojos(params.betUnitMojos)} \xB7 stack ${String(params.stackSize)}`;
  }
};
var handProposal_default3 = registration2;

// ../games/spacepoker/ui/handProposalForm.tsx
var import_react6 = __toESM(require_react());

// ../games/spacepoker/ui/AmountInput.tsx
var import_react5 = __toESM(require_react());
var import_jsx_runtime4 = __toESM(require_jsx_runtime());
var toXch = (mojos) => {
  const value = mojos.toString().padStart(13, "0");
  const whole = value.slice(0, -12).replace(/^0+/, "") || "0";
  const frac = value.slice(-12).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};
var parse = (raw, unit) => {
  if (/^\s*$/.test(raw)) return 0n;
  const value = raw.trim();
  if (unit === "mojo") return /^\d+$/.test(value) ? BigInt(value) : null;
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  return frac.length <= 12 ? BigInt(whole + frac.padEnd(12, "0")) : null;
};
function AmountInput2(props) {
  const [unit, setUnit] = (0, import_react5.useState)("mojo");
  const [raw, setRaw] = (0, import_react5.useState)(() => props.valueMojos.toString());
  const external = (0, import_react5.useRef)(props.valueMojos);
  (0, import_react5.useEffect)(() => {
    if (props.valueMojos === external.current) return;
    external.current = props.valueMojos;
    setRaw(unit === "xch" ? toXch(props.valueMojos) : props.valueMojos.toString());
  }, [props.valueMojos, unit]);
  const parsed = parse(raw, unit);
  const valid = parsed !== null && parsed > 0n;
  const exceeds = valid && props.maxMojos != null && parsed > props.maxMojos;
  const selectUnit = (next) => {
    if (next === unit) return;
    const current = parse(raw, unit);
    setUnit(next);
    if (current !== null) setRaw(next === "xch" ? toXch(current) : current.toString());
  };
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "flex flex-col items-center gap-1 text-center", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "flex flex-wrap items-center justify-center gap-2", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "text-xs text-canvas-text", children: props.label }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "flex rounded-md border border-canvas-border overflow-hidden text-xs", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", onClick: () => selectUnit("mojo"), className: `px-2 py-0.5 transition-colors ${unit === "mojo" ? "bg-canvas-bg-active font-semibold" : "hover:bg-canvas-bg-hover"}`, children: "mojo" }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", onClick: () => selectUnit("xch"), className: `px-2 py-0.5 transition-colors border-l border-canvas-border ${unit === "xch" ? "bg-canvas-bg-active font-semibold" : "hover:bg-canvas-bg-hover"}`, children: "XCH" })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "input",
      {
        type: "text",
        inputMode: unit === "xch" ? "decimal" : "numeric",
        value: raw,
        disabled: props.disabled,
        onKeyDown: props.onKeyDown,
        onChange: (event) => {
          setRaw(event.target.value);
          const next = parse(event.target.value, unit);
          if (next !== null && next > 0n) {
            external.current = next;
            props.onChange(next);
          }
        },
        className: `w-full rounded border px-2 py-1 text-center text-sm bg-canvas-bg-subtle text-canvas-text-contrast outline-none ${!valid && raw.trim() !== "" ? "border-alert-solid" : "border-canvas-line"}`
      }
    ),
    exceeds && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "flex flex-wrap items-center justify-center gap-2 text-xs text-alert-text", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { children: props.exceedsLabel }),
      props.onUseMax && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("button", { type: "button", className: "underline font-medium hover:text-alert-text-contrast transition-colors", onClick: () => {
        const max = props.maxMojos;
        external.current = max;
        setRaw(unit === "xch" ? toXch(max) : max.toString());
        props.onChange(max);
        props.onUseMax?.();
      }, children: [
        "Use max (",
        unit === "xch" ? `${toXch(props.maxMojos)} XCH` : `${props.maxMojos} mojos`,
        ")"
      ] })
    ] })
  ] });
}

// ../games/spacepoker/ui/handProposalForm.tsx
var import_jsx_runtime5 = __toESM(require_jsx_runtime());
var HandProposalForm3 = (0, import_react6.forwardRef)(function HandProposalForm4({ disabled, maxPerHandMojos, defaultContribution, initialValues, onSubmit }, ref) {
  const initialParams = initialValues?.parameters ?? null;
  const [betUnitMojos, setBetUnitMojos] = (0, import_react6.useState)(initialParams?.betUnitMojos ?? 1n);
  const [stackSize, setStackSize] = (0, import_react6.useState)(
    initialParams?.stackSize ?? (defaultContribution > 0n && betUnitMojos > 0n ? defaultContribution / betUnitMojos : 10n)
  );
  const [validationError, setValidationError] = (0, import_react6.useState)(null);
  const betSize = betUnitMojos * stackSize;
  const maxUnitSize = maxPerHandMojos != null && stackSize > 0n ? maxPerHandMojos / stackSize : null;
  (0, import_react6.useImperativeHandle)(ref, () => ({
    getProposal: () => {
      const error = betUnitMojos <= 0n || stackSize < 0n ? "Minimum raise must be positive and stack size cannot be negative." : stackSize > 0n && maxPerHandMojos !== null && betSize > maxPerHandMojos ? "Per-player stake exceeds the available reserve." : null;
      setValidationError(error);
      return error ? { ok: false, error } : {
        ok: true,
        parameters: { stackSize, betUnitMojos }
      };
    }
  }));
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(import_jsx_runtime5.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
      AmountInput2,
      {
        valueMojos: betUnitMojos,
        onChange: setBetUnitMojos,
        maxMojos: maxUnitSize,
        onUseMax: maxUnitSize != null && maxUnitSize > 0n ? () => setBetUnitMojos(maxUnitSize) : void 0,
        disabled,
        label: "Minimum raise",
        exceedsLabel: "Exceeds available reserve.",
        onKeyDown: (event) => {
          if (event.key === "Enter") onSubmit();
        }
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "flex w-full flex-col items-center gap-1", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("label", { className: "text-xs font-medium text-canvas-text", children: "Stack size (units per player)" }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
        "input",
        {
          type: "number",
          min: 0,
          className: "w-full rounded border border-canvas-line bg-canvas-bg px-2 py-1 text-center text-sm text-canvas-text-contrast focus:outline-none focus:ring-1 focus:ring-canvas-solid",
          value: stackSize.toString(),
          disabled,
          onChange: (event) => {
            const next = event.target.value.replace(/[^0-9]/g, "");
            setStackSize(BigInt(next || "0"));
          },
          onKeyDown: (event) => {
            if (event.key === "Enter") onSubmit();
          }
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "text-xs text-canvas-text", children: stackSize === 0n ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(import_jsx_runtime5.Fragment, { children: "No limit \xB7 stake resolves from both reserves when accepted" }) : /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(import_jsx_runtime5.Fragment, { children: [
      "Per-player stake: ",
      formatSpacepokerMojos(betSize),
      " \xB7 Total game size:",
      " ",
      formatSpacepokerMojos(betSize * 2n)
    ] }) }),
    validationError && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "text-xs text-alert-text", children: validationError })
  ] });
});

// ../games/spacepoker/ui/play.tsx
var import_react7 = __toESM(require_react());
var import_jsx_runtime6 = __toESM(require_jsx_runtime());
var SpacePoker = (0, import_react7.lazy)(() => import("./SpacePoker-KIIH3AQN.js"));
function SpacepokerLiveMount(props) {
  const { view } = props;
  const handState = view.hand.getState();
  const betSize = handState.perPlayerStake * 2n;
  const unitSizeMojosValue = handState.unitSizeMojos;
  const stackSize = betSize / 2n / unitSizeMojosValue;
  const handleGameLog = (0, import_react7.useCallback)(
    (lines) => {
      if (view.frozen) return;
      view.appendGameLog(
        `Space Poker ${stackSize} (${formatSpacepokerAmount(unitSizeMojosValue)})`
      );
      lines.forEach(view.appendGameLog);
      view.appendGameLog("");
    },
    [view, stackSize, unitSizeMojosValue]
  );
  return /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
    SpacePoker,
    {
      view,
      onGameLog: handleGameLog
    }
  );
}
var play2 = {
  render(view) {
    return /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(SpacepokerLiveMount, { view });
  }
};

// ../games/krunk/ui/handProposalForm.tsx
var import_react9 = __toESM(require_react());

// ../games/krunk/ui/AmountInput.tsx
var import_react8 = __toESM(require_react());
var import_jsx_runtime7 = __toESM(require_jsx_runtime());
var toXch2 = (mojos) => {
  const value = mojos.toString().padStart(13, "0");
  const whole = value.slice(0, -12).replace(/^0+/, "") || "0";
  const frac = value.slice(-12).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};
var parse2 = (raw, unit) => {
  if (/^\s*$/.test(raw)) return 0n;
  const value = raw.trim();
  if (unit === "mojo") return /^\d+$/.test(value) ? BigInt(value) : null;
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  return frac.length <= 12 ? BigInt(whole + frac.padEnd(12, "0")) : null;
};
function AmountInput3(props) {
  const [unit, setUnit] = (0, import_react8.useState)("mojo");
  const [raw, setRaw] = (0, import_react8.useState)(() => props.valueMojos.toString());
  const external = (0, import_react8.useRef)(props.valueMojos);
  (0, import_react8.useEffect)(() => {
    if (props.valueMojos === external.current) return;
    external.current = props.valueMojos;
    setRaw(unit === "xch" ? toXch2(props.valueMojos) : props.valueMojos.toString());
  }, [props.valueMojos, unit]);
  const parsed = parse2(raw, unit);
  const valid = parsed !== null && parsed > 0n;
  const exceeds = valid && props.maxMojos != null && parsed > props.maxMojos;
  const selectUnit = (next) => {
    if (next === unit) return;
    const current = parse2(raw, unit);
    setUnit(next);
    if (current !== null) setRaw(next === "xch" ? toXch2(current) : current.toString());
  };
  return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "flex flex-col items-center gap-1 text-center", children: [
    /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "flex flex-wrap items-center justify-center gap-2", children: [
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { className: "text-xs text-canvas-text", children: props.label }),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "flex rounded-md border border-canvas-border overflow-hidden text-xs", children: [
        /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("button", { type: "button", onClick: () => selectUnit("mojo"), className: `px-2 py-0.5 transition-colors ${unit === "mojo" ? "bg-canvas-bg-active font-semibold" : "hover:bg-canvas-bg-hover"}`, children: "mojo" }),
        /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("button", { type: "button", onClick: () => selectUnit("xch"), className: `px-2 py-0.5 transition-colors border-l border-canvas-border ${unit === "xch" ? "bg-canvas-bg-active font-semibold" : "hover:bg-canvas-bg-hover"}`, children: "XCH" })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
      "input",
      {
        type: "text",
        inputMode: unit === "xch" ? "decimal" : "numeric",
        value: raw,
        disabled: props.disabled,
        onKeyDown: props.onKeyDown,
        onChange: (event) => {
          setRaw(event.target.value);
          const next = parse2(event.target.value, unit);
          if (next !== null && next > 0n) {
            external.current = next;
            props.onChange(next);
          }
        },
        className: `w-full rounded border px-2 py-1 text-center text-sm bg-canvas-bg-subtle text-canvas-text-contrast outline-none ${!valid && raw.trim() !== "" ? "border-alert-solid" : "border-canvas-line"}`
      }
    ),
    exceeds && /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("div", { className: "flex flex-wrap items-center justify-center gap-2 text-xs text-alert-text", children: [
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("span", { children: props.exceedsLabel }),
      props.onUseMax && /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)("button", { type: "button", className: "underline font-medium hover:text-alert-text-contrast transition-colors", onClick: () => {
        const max = props.maxMojos;
        external.current = max;
        setRaw(unit === "xch" ? toXch2(max) : max.toString());
        props.onChange(max);
        props.onUseMax?.();
      }, children: [
        "Use max (",
        unit === "xch" ? `${toXch2(props.maxMojos)} XCH` : `${props.maxMojos} mojos`,
        ")"
      ] })
    ] })
  ] });
}

// ../games/krunk/ui/handProposalForm.tsx
var import_jsx_runtime8 = __toESM(require_jsx_runtime());
var HandProposalForm5 = (0, import_react9.forwardRef)(function HandProposalForm6({ disabled, maxPerHandMojos, defaultContribution, initialValues, onSubmit }, ref) {
  const initialAmount = initialValues ? initialValues.parameters : defaultContribution > 0n ? defaultContribution : 100n;
  const [amount, setAmount] = (0, import_react9.useState)(initialAmount);
  const [validationError, setValidationError] = (0, import_react9.useState)(null);
  const maxMojos = maxPerHandMojos != null ? maxPerHandMojos - maxPerHandMojos % 100n : maxPerHandMojos;
  (0, import_react9.useImperativeHandle)(ref, () => ({
    getProposal: () => {
      const error = !isValidKrunkStake(amount) ? "Krunk stakes must be positive multiples of 100 mojos." : maxMojos !== null && amount > maxMojos ? "Per-player stake exceeds the available reserve." : null;
      setValidationError(error);
      return error ? { ok: false, error } : {
        ok: true,
        parameters: amount
      };
    }
  }));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(import_jsx_runtime8.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
      AmountInput3,
      {
        valueMojos: amount,
        onChange: setAmount,
        maxMojos,
        onUseMax: maxMojos != null && maxMojos > 0n ? () => setAmount(maxMojos) : void 0,
        disabled,
        label: "Per-player stake",
        exceedsLabel: "Exceeds available reserve.",
        onKeyDown: (event) => {
          if (event.key === "Enter") onSubmit();
        }
      }
    ),
    amount > 0n && !isValidKrunkStake(amount) && /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("p", { className: "text-xs text-alert-text", children: "Krunk stakes must be multiples of 100 mojos." }),
    validationError && isValidKrunkStake(amount) && /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("p", { className: "text-xs text-alert-text", children: validationError })
  ] });
});

// ../games/krunk/ui/play.tsx
var import_react10 = __toESM(require_react());
var import_jsx_runtime9 = __toESM(require_jsx_runtime());
var Krunk = (0, import_react10.lazy)(() => import("./Krunk-P7WTSVO5.js"));
function KrunkLiveMount(props) {
  const { view } = props;
  const handleGameLog = (0, import_react10.useCallback)(
    (lines) => {
      if (view.frozen) return;
      lines.forEach(view.appendGameLog);
      view.appendGameLog("");
    },
    [view]
  );
  return /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Krunk, { view, onGameLog: handleGameLog });
}
var play3 = {
  render(view) {
    return /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(KrunkLiveMount, { view });
  }
};

// src/generated/gamePresets.ts
var PRODUCTION_PACKAGE_KEYS = ["calpoker", "spacepoker", "krunk"];
var CORE_PRESET_FILES = [
  "clsp/unroll/unroll_puzzle_state_channel_unrolling.clvm.bin",
  "clsp/referee/onchain/referee.clvm.bin"
];
var GAME_PRESET_FILES = [
  "games/calpoker/clsp/factory_prepared.clvm.bin",
  "games/spacepoker/clsp/factory_prepared.clvm.bin",
  "games/krunk/clsp/factory_prepared.clvm.bin"
];
var PRESET_FILES = [...CORE_PRESET_FILES, ...GAME_PRESET_FILES];
var DEBUG_PRESET_FILES = [...CORE_PRESET_FILES, ...GAME_PRESET_FILES].map(
  (file) => file.replace(/\.clvm\.bin$/, ".debug.clvm.bin")
);

// src/generated/gamePackages.ts
var pkg0 = defineGamePackage(handProposal_default2, HandProposalForm, play);
var pkg1 = defineGamePackage(handProposal_default3, HandProposalForm3, play2);
var pkg2 = defineGamePackage(handProposal_default, HandProposalForm5, play3);
var GENERATED_GAME_PACKAGES_BY_KEY = {
  calpoker: pkg0,
  spacepoker: pkg1,
  krunk: pkg2
};
var GENERATED_GAME_PACKAGES = Object.values(GENERATED_GAME_PACKAGES_BY_KEY);

// src/lib/session/gameTimeout.ts
var import_chia_gaming_protocol_constants = __toESM(require_protocol_constants(), 1);
var MIN_GAME_TIMEOUT_BLOCKS = BigInt(import_chia_gaming_protocol_constants.default.gameTimeoutBlocks.min);
var MAX_GAME_TIMEOUT_BLOCKS = BigInt(import_chia_gaming_protocol_constants.default.gameTimeoutBlocks.max);
function isValidGameTimeoutBlocks(timeout) {
  return timeout >= MIN_GAME_TIMEOUT_BLOCKS && timeout <= MAX_GAME_TIMEOUT_BLOCKS;
}

// src/lib/gameRegistry.ts
function packageFor(gameType) {
  return GENERATED_GAME_PACKAGES_BY_KEY[gameType];
}
function gameDisplayName(gameType) {
  return packageFor(gameType).displayName;
}
function isCatalogGameType(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(GENERATED_GAME_PACKAGES_BY_KEY, value);
}
var DEFAULT_CATALOG_GAME_TYPE = PRODUCTION_PACKAGE_KEYS[0];
var REGISTERED_GAMES = PRODUCTION_PACKAGE_KEYS.map((gameType) => ({
  gameType,
  displayName: packageFor(gameType).displayName
}));
function decodePersistedGameState(value) {
  if (typeof value !== "object" || value === null) return null;
  const persisted = value;
  if (Object.keys(persisted).length !== 2 || !Object.hasOwn(persisted, "gameType") || !Object.hasOwn(persisted, "state") || !isCatalogGameType(persisted.gameType)) {
    return null;
  }
  return { gameType: persisted.gameType, state: persisted.state };
}
function restoreRegisteredGameHandState(gameType, persisted) {
  if (persisted.gameType !== gameType) {
    throw new Error(`Saved ${persisted.gameType} state cannot restore ${gameType}`);
  }
  return packageFor(gameType).restoreHand(persisted.state);
}
function snapshotRegisteredGameHand(gameType, hand) {
  return { gameType, state: hand.getState() };
}
function restoreRegisteredGameHand(model) {
  const { game } = model;
  if (game.handState === null) return null;
  return restoreRegisteredGameHandState(game.activeGameType, game.handState);
}
function isProposalParameterValue(value) {
  return value === null || typeof value === "boolean" || typeof value === "bigint" || typeof value === "string" || value instanceof Uint8Array || Array.isArray(value) && value.every(isProposalParameterValue);
}
function validateHandProposal(handProposal) {
  return isCatalogGameType(handProposal.gameType) && typeof handProposal.senderIsPlayerA === "boolean" && typeof handProposal.gameTimeout === "bigint" && isValidGameTimeoutBlocks(handProposal.gameTimeout) && isProposalParameterValue(handProposal.parameters);
}
function proposalParameterValuesEqual(a, b) {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((value, index) => value === b[index]);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => proposalParameterValuesEqual(value, b[index]));
  }
  return a === b;
}
function handProposalsEqual(a, aOrigin, b, bOrigin) {
  if (!a || !b || !aOrigin || !bOrigin || a.gameType !== b.gameType) return false;
  const localIsPlayerAForA = aOrigin === "local" === a.senderIsPlayerA;
  const localIsPlayerAForB = bOrigin === "local" === b.senderIsPlayerA;
  return localIsPlayerAForA === localIsPlayerAForB && a.gameTimeout === b.gameTimeout && proposalParameterValuesEqual(a.parameters, b.parameters);
}
function describeReceivedProposal(handProposal) {
  return packageFor(handProposal.gameType).describeHandProposal(handProposal);
}

// src/lib/settlement.ts
var SETTLEMENT_OUTCOME_LABELS = {
  accept_settlement: "Accepted",
  settled_cleanly: "Settled cleanly",
  opponent_timed_out: "Opponent timed out",
  forfeited_skipped_reveal: "Forfeited",
  lost: "Lost",
  forfeited_we_accepted: "Forfeited",
  we_accepted: "Accepted",
  attempt_to_move_failed: "Attempt to move failed",
  timed_out_waiting_for_our_move: "Timed out waiting for our move",
  slashed_opponent: "Slashed opponent",
  opponent_slashed_us: "Opponent slashed us",
  opponent_cheated: "Opponent cheated"
};
function settlementLabel(outcome) {
  return SETTLEMENT_OUTCOME_LABELS[outcome];
}
function isErrorSettlementOutcome(outcome) {
  return outcome === "forfeited_skipped_reveal" || outcome === "forfeited_we_accepted" || outcome === "timed_out_waiting_for_our_move" || outcome === "attempt_to_move_failed" || outcome === "opponent_slashed_us" || outcome === "opponent_cheated";
}
function parseSettlementShare(value) {
  if (value == null) return null;
  if (typeof value === "object" && value !== null && "Amount" in value) {
    return String(value.Amount);
  }
  if (typeof value === "object" && value !== null && "amt" in value) {
    return String(value.amt);
  }
  return String(value);
}

// src/lib/session/historyLimits.ts
var HUMAN_HISTORY_LIMIT = 1e3;
var WASM_NOTIFICATION_HISTORY_LIMIT = 1e3;
var DIAGNOSTIC_LOG_LIMIT = 2e3;
var DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT = 256 * 1024;
var utf8Encoder = new TextEncoder();
function recentEntries(entries, limit) {
  return entries.length <= limit ? [...entries] : entries.slice(-limit);
}
function appendRecent(entries, entry, limit) {
  return entries.length < limit ? [...entries, entry] : [...entries.slice(-(limit - 1)), entry];
}
function recentDiagnosticEntries(entries) {
  const countBounded = recentEntries(entries, DIAGNOSTIC_LOG_LIMIT);
  const retained = [];
  let bytes = 0;
  for (let index = countBounded.length - 1; index >= 0; index -= 1) {
    const entry = countBounded[index];
    const entryBytes = utf8Encoder.encode(entry).byteLength;
    if (entryBytes > DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT) continue;
    if (bytes + entryBytes > DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT) break;
    retained.push(entry);
    bytes += entryBytes;
  }
  retained.reverse();
  return retained;
}
function appendDiagnosticEntry(entries, entry) {
  return recentDiagnosticEntries([...entries, entry]);
}

// src/services/log.ts
var buffer = [];
var listeners = /* @__PURE__ */ new Set();
function timestamp() {
  const d = /* @__PURE__ */ new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}
function log(line) {
  const stamped = `[${timestamp()}] ${line}`;
  buffer = appendDiagnosticEntry(buffer, stamped);
  listeners.forEach((fn) => fn(stamped));
}
function subscribeLog(fn) {
  buffer.forEach(fn);
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function recentLogText() {
  return buffer.slice(-20).join("\n").slice(-8e3);
}
function diagNote(message) {
  console.warn(`[error] ${message}`);
}
function diagStack(context, e) {
  let name = "Error";
  let message;
  let stack;
  if (e instanceof Error) {
    name = e.name;
    message = e.message || "(empty message)";
    stack = e.stack ?? "(no stack)";
  } else {
    try {
      message = typeof e === "string" ? e : JSON.stringify(e);
    } catch {
      message = String(e);
    }
    stack = new Error("(non-Error thrown; stack captured at catch site)").stack ?? "(no stack)";
  }
  console.error(`[error] ${context}: ${name}: ${message}
${stack}`);
}

// src/lib/session/providerKeys.ts
function tupleKey(parts) {
  return parts.map((part) => `${part.length}:${part}`).join("");
}
function providerScopeKey(scope) {
  switch (scope.provider) {
    case "cloud":
      return tupleKey(["cloud", scope.walletId]);
    case "walletconnect":
      return tupleKey(["walletconnect", scope.fingerprint, scope.chainId]);
    case "sage":
      return tupleKey(["sage", scope.fingerprint, scope.chainId]);
    case "simulator":
      return tupleKey(["simulator", scope.identity]);
  }
}
function providerOwnerKey(owner) {
  return tupleKey([
    owner.installationPlayerId,
    owner.peerSessionId,
    providerScopeKey(owner.providerScope)
  ]);
}

// src/util/distribution.ts
function isElectronDistribution() {
  return typeof window !== "undefined" && window.__chiaDistribution === "electron";
}

// src/lib/session/saveCoordination.ts
var SESSION_MARKER_KEY = "appState_savedSession";
var RESET_KEY = "appState_hardReset";
var LEASE_KEY = "appState_activeTab";
var TAB_ID_SESSION_KEY = "appState_tabId";
function randomHex() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
var tabId = (() => {
  if (typeof sessionStorage !== "undefined") {
    const existing = sessionStorage.getItem(TAB_ID_SESSION_KEY);
    if (existing) return existing;
  }
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : randomHex();
  try {
    sessionStorage.setItem(TAB_ID_SESSION_KEY, id);
  } catch {
  }
  return id;
})();
function getStorageTabId() {
  return tabId;
}
function leaseHasLivePeer() {
  const current = localStorage.getItem(LEASE_KEY);
  if (current === null || current === tabId) return false;
  return !isElectronDistribution();
}
function isLeaseConflict() {
  try {
    return leaseHasLivePeer();
  } catch {
    return false;
  }
}
function checkLease() {
  try {
    return !leaseHasLivePeer();
  } catch {
    return true;
  }
}
function markLeaseClaimed() {
  try {
    localStorage.setItem(LEASE_KEY, tabId);
  } catch {
  }
}
function releaseLeaseIfOwner() {
  try {
    if (localStorage.getItem(LEASE_KEY) === tabId) {
      localStorage.removeItem(LEASE_KEY);
    }
  } catch {
  }
}
function markSavedSession() {
  try {
    localStorage.setItem(SESSION_MARKER_KEY, "1");
  } catch {
  }
}
function clearSavedSessionMarker() {
  try {
    localStorage.removeItem(SESSION_MARKER_KEY);
  } catch {
  }
}
function isWalletConnectStorageKey(key) {
  const lower = key.toLowerCase();
  return lower.startsWith("wc@") || lower.includes("walletconnect") || lower.includes("wallet_connect");
}
function hasWalletConnectStorage() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && isWalletConnectStorageKey(key)) return true;
    }
  } catch {
  }
  return false;
}
function signalHardResetToOtherTabs() {
  try {
    localStorage.setItem(RESET_KEY, `${Date.now()}:${randomHex()}`);
  } catch (error) {
    console.error("[save] failed to signal hard reset to other tabs:", error);
  }
}
function installStorageCoordination(onAuthorityLost, onHardReset) {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("storage", (event) => {
    if (event.key === RESET_KEY) {
      onAuthorityLost("sibling-reset");
      onHardReset();
      return;
    }
    if (event.key === LEASE_KEY && event.newValue !== tabId) {
      onAuthorityLost("takeover");
    }
  });
  setInterval(() => {
    if (!checkLease()) {
      onAuthorityLost("takeover");
    }
  }, 3e3);
}
function resetStorageCoordinationForTests() {
  try {
    localStorage.removeItem(LEASE_KEY);
  } catch {
  }
  try {
    localStorage.removeItem(RESET_KEY);
  } catch {
  }
}

// src/constants/fees.ts
var DEFAULT_TRANSACTION_FEE_MOJOS = 100000000n;

// src/lib/session/sessionPreferences.ts
function selectSessionPreference(state, key) {
  const preferences = state.preferences;
  const values = {
    myHubPlayerId: state.identity.myHubPlayerId,
    blockchainType: preferences.blockchainType,
    network: preferences.network ?? "mainnet",
    alias: preferences.alias,
    theme: preferences.theme,
    defaultFee: preferences.defaultFee ?? DEFAULT_TRANSACTION_FEE_MOJOS,
    feeUnit: preferences.feeUnit ?? "mojo",
    activeTab: preferences.activeTab,
    unreadGame: preferences.unreadGame ?? false,
    walletAlert: preferences.walletAlert ?? false,
    hubAlert: preferences.hubAlert ?? false,
    hubUrl: preferences.hubUrl,
    lastHubUrl: preferences.lastHubUrl
  };
  return values[key];
}
function applySessionPreferenceUpdate(state, update) {
  return {
    ...state,
    preferences: {
      ...state.preferences,
      ...preferencePatch(update)
    }
  };
}
function preferencePatch(update) {
  switch (update.key) {
    case "unreadGame":
    case "walletAlert":
    case "hubAlert":
      return { [update.key]: update.value || void 0 };
    case "hubUrl":
    case "lastHubUrl":
      return { [update.key]: update.value || void 0 };
    default:
      return { [update.key]: update.value };
  }
}

// src/lib/session/sessionStateTransitions.ts
function freshSessionState(previous) {
  return { ...previous, session: null };
}
function capSessionHistories(state) {
  return {
    ...state,
    history: {
      ...state.history,
      humanHistory: state.history.humanHistory ? recentEntries(state.history.humanHistory, HUMAN_HISTORY_LIMIT) : void 0,
      wasmNotificationHistory: state.history.wasmNotificationHistory ? recentEntries(state.history.wasmNotificationHistory, WASM_NOTIFICATION_HISTORY_LIMIT) : void 0,
      diagnosticLog: state.history.diagnosticLog ? recentDiagnosticEntries(state.history.diagnosticLog) : void 0
    }
  };
}
function mergeClaimedSession(record, fallback, patch) {
  const base = record ?? fallback;
  return capSessionHistories({
    ...base,
    identity: { ...base.identity, ...patch.identity },
    preferences: { ...base.preferences, ...patch.preferences },
    history: { ...base.history, ...patch.history }
  });
}
function applyCommonPatch(state, patch) {
  return capSessionHistories({
    ...state,
    identity: { ...state.identity, ...patch.identity },
    preferences: { ...state.preferences, ...patch.preferences },
    history: { ...state.history, ...patch.history }
  });
}
function patchSessionTransport(state, transport) {
  if (state.session?.phase === "pre-handshake") {
    return {
      ...state,
      session: { ...state.session, transport: structuredClone(transport) }
    };
  }
  if (state.session?.phase === "live") {
    return {
      ...state,
      session: {
        ...state.session,
        live: { ...state.session.live, ...structuredClone(transport) }
      }
    };
  }
  throw new Error(
    `Cannot patch session transport while session phase is ${String(state.session?.phase)}`
  );
}
function clearSessionPeer(state) {
  if (state.session?.phase !== "live" && state.session?.phase !== "pre-handshake") return state;
  return {
    ...state,
    session: {
      ...state.session,
      pairing: { ...state.session.pairing, peerId: void 0 }
    }
  };
}
function preservationCheckpoint(state) {
  if (state.session?.phase === "pre-handshake") {
    return state.session;
  }
  if (state.session?.phase !== "live") return null;
  return {
    phase: "pre-handshake",
    pairing: state.session.pairing,
    transport: {
      messageNumber: state.session.live.messageNumber,
      remoteNumber: state.session.live.remoteNumber,
      unackedMessages: state.session.live.unackedMessages,
      disposition: state.session.live.disposition,
      terminalHandoff: state.session.live.terminalHandoff
    }
  };
}
function clearGameSessionState(state, history) {
  const current = applyCommonPatch(state, { history });
  const session = preservationCheckpoint(current);
  return {
    ...current,
    session
  };
}
function commonPatch(before, after) {
  return {
    identity: changedFields(before.identity, after.identity),
    preferences: changedFields(before.preferences, after.preferences),
    history: changedFields(before.history, after.history)
  };
}
function changedFields(before, after) {
  return Object.fromEntries(
    Object.keys(after).flatMap(
      (key) => comparable(before[key]) === comparable(after[key]) ? [] : [[key, structuredClone(after[key])]]
    )
  );
}
function comparable(value) {
  return JSON.stringify(value, (_name, entry) => typeof entry === "bigint" ? `${entry}n` : entry);
}

// src/lib/session/channelFundingStore.ts
var MAX_CHANNEL_FUNDING_REASON_LENGTH = 256;
function tupleKey2(parts) {
  return parts.map((part) => `${part.length}:${part}`).join("");
}
function channelFundingKey(owner, purpose) {
  return tupleKey2([providerOwnerKey(owner), purpose.operationId]);
}
function channelFundingRecoveryKey(owner, purpose) {
  return `operation:${channelFundingKey(owner, purpose)}`;
}
function channelFundingTradeKey(id) {
  return `reservation:${id}`;
}
function channelFundingEntryKey(entry) {
  return entry.stage === "creating" || entry.stage === "best-effort-uncertain" ? channelFundingRecoveryKey(entry.owner, entry.purpose) : channelFundingTradeKey(entry.providerReservationId);
}

// src/lib/session/walletProviderRegistry.ts
var WalletProviderRegistry = class {
  providers = /* @__PURE__ */ new Map();
  epochs = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  attach(provider) {
    const key = providerScopeKey(provider.scope);
    const current = this.providers.get(key);
    if (current === provider) return this.epochs.get(key) ?? 0;
    this.providers.set(key, provider);
    const readinessEpoch = (this.epochs.get(key) ?? 0) + 1;
    this.epochs.set(key, readinessEpoch);
    this.emit({ kind: "attached", provider, readinessEpoch });
    return readinessEpoch;
  }
  ready(provider) {
    const key = providerScopeKey(provider.scope);
    if (this.providers.get(key) !== provider) return this.epochs.get(key) ?? 0;
    const readinessEpoch = this.epochs.get(key) ?? 1;
    this.epochs.set(key, readinessEpoch);
    this.emit({ kind: "ready", provider, readinessEpoch });
    return readinessEpoch;
  }
  reconnectReady(provider) {
    const key = providerScopeKey(provider.scope);
    if (this.providers.get(key) !== provider) return this.attach(provider);
    const readinessEpoch = (this.epochs.get(key) ?? 0) + 1;
    this.epochs.set(key, readinessEpoch);
    this.emit({ kind: "ready", provider, readinessEpoch });
    return readinessEpoch;
  }
  detach(provider) {
    const key = providerScopeKey(provider.scope);
    if (this.providers.get(key) !== provider) return;
    this.providers.delete(key);
    this.emit({ kind: "detached", provider, readinessEpoch: this.epochs.get(key) ?? 0 });
  }
  provider(scope) {
    return this.providers.get(providerScopeKey(scope)) ?? null;
  }
  hasScope(scope) {
    return this.providers.has(providerScopeKey(scope));
  }
  readinessEpoch(scope) {
    return this.epochs.get(providerScopeKey(scope)) ?? 0;
  }
  scopeKeys() {
    return new Set(this.providers.keys());
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  clear() {
    const attached = [...this.providers.values()];
    this.providers.clear();
    for (const provider of attached) {
      this.emit({
        kind: "detached",
        provider,
        readinessEpoch: this.epochs.get(providerScopeKey(provider.scope)) ?? 0
      });
    }
  }
  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
};
var walletProviderRegistry = new WalletProviderRegistry();

// src/lib/session/providerCapabilities.ts
function isRecoverableProvider(provider) {
  return provider.capability === "recoverable" || provider.capability === "recoverable-after-begin";
}
function canLosePreIdResponse(provider) {
  return provider.capability === "best-effort" || provider.capability === "recoverable-after-begin";
}

// src/lib/session/channelFundingSelectors.ts
function walletSessionKey(installationPlayerId, peerSessionId) {
  return `${installationPlayerId.length}:${installationPlayerId}${peerSessionId.length}:${peerSessionId}`;
}
function providerRequestFromRecovery(owner, request) {
  const canonical = request.canonical;
  return {
    kind: "funding",
    uniqueId: owner.installationPlayerId,
    offer: { "1": -BigInt(canonical.amount) },
    extraConditions: canonical.conditions.map(({ opcode, args }) => ({ opcode, args: [...args] })),
    ...canonical.coin_id === void 0 ? {} : { coinIds: [canonical.coin_id] },
    ...canonical.max_height === void 0 ? {} : { maxHeight: BigInt(canonical.max_height) },
    openingFee: BigInt(canonical.fee)
  };
}
function restoredFundingForSink(entries, sinkKey) {
  const matches = entries.filter(
    (entry) => entry.stage === "creating" && entry.disposition === "active" && entry.purpose.kind === "funding" && entry.request.kind === "funding" && walletSessionKey(entry.owner.installationPlayerId, entry.owner.peerSessionId) === sinkKey
  );
  if (matches.length > 1) throw new Error("Conflicting restored funding recoveries");
  return matches[0] ?? null;
}
function entryForOperation(entries, owner, purpose) {
  const key = channelFundingKey(owner, purpose);
  const matches = [...entries].filter(
    (entry) => channelFundingKey(entry.owner, entry.purpose) === key
  );
  const recovery = matches.filter(
    (entry) => entry.stage === "creating" || entry.stage === "best-effort-uncertain"
  );
  if (recovery.length > 1) {
    throw new Error("Channel funding contains contradictory recovery entries");
  }
  return recovery[0] ?? matches[0] ?? null;
}
function walletRecoveryNotice(entries, scopeKeys) {
  const pending = entries.filter(
    (entry) => (entry.stage === "creating" || entry.stage === "best-effort-uncertain") && entry.disposition === "active" && !scopeKeys.has(providerScopeKey(entry.owner.providerScope))
  );
  if (!pending.length) return null;
  return {
    key: JSON.stringify(
      pending.map(
        (entry) => providerOwnerKey(entry.owner) + ("submissionId" in entry ? `:fee:${entry.submissionId}` : `:funding:${entry.purpose.operationId}`)
      ).sort()
    ),
    message: `There ${pending.length === 1 ? "is" : "are"} ${pending.length} unfinished wallet request${pending.length === 1 ? "" : "s"} from an earlier wallet account. Reconnect that account to retry ${pending.length === 1 ? "it" : "them"}.`
  };
}

// src/lib/session/providerExecution.ts
function coalesceProviderFlight(flights, key, launch, resume, epoch) {
  const existing = flights.get(key);
  if (existing) {
    if (epoch !== void 0 && (existing.pendingEpoch === void 0 || epoch > existing.pendingEpoch)) {
      existing.pendingEpoch = epoch;
    }
    return existing.promise;
  }
  const flight = {
    ...epoch === void 0 ? {} : { pendingEpoch: epoch },
    promise: Promise.resolve().then(() => launch(flight)).finally(() => {
      if (flights.get(key) === flight) flights.delete(key);
      if (flight.pendingEpoch !== void 0) resume?.();
    })
  };
  flights.set(key, flight);
  return flight.promise;
}
async function checkpoint(generation) {
  try {
    await storageRepository.checkpointDomainMutations();
  } catch (error) {
    if (error instanceof StorageAuthorityLostError) throw error;
    log(`[provider-execution] aggregate persistence failed: ${String(error)}`);
  }
  if (!storageRepository.isGenerationCurrent(generation)) throw new StorageAuthorityLostError();
}
async function advanceProviderCreation(generation, provider, operation, request, recoveryId) {
  await checkpoint(generation);
  if (recoveryId === void 0) return provider.beginCreation(operation, request);
  if (!isRecoverableProvider(provider)) {
    throw new Error("Provider cannot reconcile persisted creation");
  }
  return provider.reconcileCreation(operation, request, recoveryId);
}
async function advanceProviderCancellation(generation, provider, providerReservationId, recoveryId) {
  await checkpoint(generation);
  if (recoveryId !== void 0) {
    if (!isRecoverableProvider(provider)) {
      throw new Error("Provider cannot reconcile persisted cancellation");
    }
    return provider.reconcileCancellation(providerReservationId, recoveryId);
  }
  if (provider.capability === "best-effort" || provider.capability === "terminal") {
    return provider.cancel(providerReservationId);
  }
  return provider.beginCancellation(providerReservationId);
}
async function checkpointProviderState(generation) {
  await checkpoint(generation);
}

// src/lib/session/walletReservationRetirement.ts
var fundingCancellationGeneration = -1;
var fundingCancellations = /* @__PURE__ */ new Map();
function currentFundingCancellations() {
  const generation = storageRepository.lifecycleGeneration;
  if (fundingCancellationGeneration !== generation) {
    fundingCancellationGeneration = generation;
    fundingCancellations = /* @__PURE__ */ new Map();
  }
  return fundingCancellations;
}
function runFundingCancellation(entry, cancel, resume, epoch) {
  const key = JSON.stringify([
    channelFundingKey(entry.owner, entry.purpose),
    entry.providerReservationId
  ]);
  return coalesceProviderFlight(currentFundingCancellations(), key, cancel, resume, epoch);
}
async function flushFundingCancellations() {
  const flights = currentFundingCancellations();
  while (flights.size > 0) {
    await Promise.allSettled([...flights.values()].map((flight) => flight.promise));
  }
}
function finishRetiredFundingCancellation(provider, entry) {
  return cancelReservation(provider, entry);
}
function retireWalletReservations(state, peerSessionId) {
  const retired = (entry) => peerSessionId === void 0 || entry.owner.peerSessionId === peerSessionId;
  cancelRetiredWalletReservations(
    [...state.channelFundingOperations, ...state.feeAttachments].filter(retired)
  );
  return {
    ...state,
    channelFundingOperations: state.channelFundingOperations.filter((entry) => !retired(entry)),
    feeAttachments: state.feeAttachments.filter((entry) => !retired(entry))
  };
}
function cancelRetiredWalletReservations(entries) {
  for (const entry of entries) {
    const provider = walletProviderRegistry.provider(entry.owner.providerScope);
    if (provider) cancelRetiredWalletReservation(provider, entry);
  }
}
function cancelRetiredWalletReservation(provider, entry) {
  void Promise.resolve().then(
    () => !("submissionId" in entry) && entry.stage !== "creating" && entry.stage !== "best-effort-uncertain" ? runFundingCancellation(entry, () => cancelReservation(provider, entry)) : cancelReservation(provider, entry)
  ).catch((error) => {
    log(`[wallet-retirement] best-effort cancellation failed: ${String(error)}`);
  });
}
async function cancelReservation(provider, entry) {
  if (entry.stage === "best-effort-uncertain") return;
  let id;
  if (entry.stage === "creating") {
    if (!isRecoverableProvider(provider)) return;
    const request = "submissionId" in entry ? entry.request : providerRequestFromRecovery(entry.owner, entry.request);
    const purpose = "submissionId" in entry ? { kind: "fee", operationId: entry.submissionId } : entry.purpose;
    const outcome2 = await provider.reconcileCreation(
      { owner: entry.owner, purpose },
      request,
      entry.recoveryId,
      { mode: "observe-only" }
    );
    if (outcome2.kind !== "created-reserved") return;
    id = outcome2.tradeId;
  } else {
    id = entry.providerReservationId;
  }
  if (hasLiveReservation(provider, id)) return;
  let outcome = entry.stage === "cancelling" && isRecoverableProvider(provider) ? await provider.reconcileCancellation(id, entry.recoveryId) : provider.capability === "best-effort" || provider.capability === "terminal" ? await provider.cancel(id) : await provider.beginCancellation(id);
  if (outcome.status === "pending" && isRecoverableProvider(provider)) {
    if (hasLiveReservation(provider, id)) return;
    outcome = await provider.reconcileCancellation(id, outcome.recoveryId);
  }
  if (outcome.status !== "cancelled" && outcome.status !== "already-terminal") {
    log(
      `[wallet-retirement] best-effort cancellation incomplete reservation=${id} status=${outcome.status}`
    );
  }
}
function hasLiveReservation(provider, id) {
  const state = storageRepository.loadState();
  return [...state.channelFundingOperations, ...state.feeAttachments].some(
    (entry) => entry.stage !== "creating" && entry.stage !== "best-effort-uncertain" && entry.providerReservationId === id && providerScopeKey(entry.owner.providerScope) === providerScopeKey(provider.scope)
  );
}

// src/lib/session/storageRepository.ts
function newApplicationState() {
  return {
    schema: DURABLE_APPLICATION_STATE_SCHEMA,
    version: DURABLE_APPLICATION_STATE_VERSION,
    identity: { playerId: randomHex() },
    preferences: {},
    history: {},
    session: null,
    walletContext: null,
    channelFundingOperations: [],
    feeAttachments: [],
    rejectionTransports: []
  };
}
var StorageRepository = class {
  authority = null;
  generation = 0;
  lifecycle = 0;
  claimSequence = 0;
  fenced = false;
  mutationTail = Promise.resolve();
  authorityLostListeners = /* @__PURE__ */ new Set();
  walletOperationListeners = /* @__PURE__ */ new Set();
  lifecycleListeners = /* @__PURE__ */ new Set();
  pendingMutationBarrierForTests = null;
  pendingCheckpointHoldForTests = null;
  pendingClaimHoldForTests = null;
  activeRuntime = null;
  get lifecycleGeneration() {
    return this.generation;
  }
  isGenerationCurrent(generation) {
    return generation === this.generation && this.hasAuthority();
  }
  onLifecycle(listener) {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }
  onWalletOperationsChange(listener) {
    this.walletOperationListeners.add(listener);
    return () => this.walletOperationListeners.delete(listener);
  }
  notifyWalletOperations() {
    for (const listener of this.walletOperationListeners) listener();
  }
  hasAuthority() {
    return this.authority !== null && !this.fenced;
  }
  onAuthorityLost(listener) {
    this.authorityLostListeners.add(listener);
    return () => this.authorityLostListeners.delete(listener);
  }
  loseAuthority(reason) {
    if (this.fenced) return;
    this.fenced = true;
    this.generation += 1;
    this.notifyLifecycle("authority-lost");
    this.notifyAuthorityLost(reason);
  }
  notifyLifecycle(event) {
    for (const listener of this.lifecycleListeners) {
      try {
        listener(this.generation, event);
      } catch {
      }
    }
  }
  notifyAuthorityLost(reason) {
    for (const listener of this.authorityLostListeners) {
      try {
        listener(reason);
      } catch {
      }
    }
  }
  async claimAndRead(ownerTabId) {
    const lifecycle = this.lifecycle;
    const generation = this.generation;
    const claimSequence = ++this.claimSequence;
    const snapshot = await indexedDbStoragePort.claimAndRead(ownerTabId);
    if (lifecycle !== this.lifecycle || generation !== this.generation || claimSequence !== this.claimSequence) {
      throw new StorageAuthorityLostError();
    }
    this.authority = snapshot.authority;
    this.generation += 1;
    this.fenced = false;
    const claimedGeneration = this.generation;
    const hold = this.pendingClaimHoldForTests;
    this.pendingClaimHoldForTests = null;
    if (hold) {
      hold.claimed();
      await hold.barrier;
    }
    if (lifecycle !== this.lifecycle || claimSequence !== this.claimSequence || claimedGeneration !== this.generation || this.fenced || !this.authority || this.authority.ownerTabId !== snapshot.authority.ownerTabId || this.authority.writeEpoch !== snapshot.authority.writeEpoch || this.authority.resetEpoch !== snapshot.authority.resetEpoch) {
      throw new StorageAuthorityLostError();
    }
    return snapshot;
  }
  async inspect() {
    await this.mutationTail;
    return inspectApplicationState();
  }
  async beginHardReset(ownerTabId) {
    const authority = await indexedDbStoragePort.beginHardReset(ownerTabId);
    this.authority = authority;
    this.generation += 1;
    this.fenced = true;
    this.notifyLifecycle("hard-reset");
    return authority;
  }
  hardResetMutation(authority, reset) {
    return this.enqueue(
      authority,
      this.generation,
      async () => {
        await indexedDbStoragePort.validatePendingHardReset(authority);
        await reset();
      },
      true
    );
  }
  async write(snapshot) {
    await this.runAuthorizedMutation(async (authority) => {
      await indexedDbStoragePort.writeApplicationState(snapshot, authority);
      const hold = this.pendingCheckpointHoldForTests;
      this.pendingCheckpointHoldForTests = null;
      if (hold) {
        hold.committed();
        await hold.barrier;
      }
    }).catch((error) => {
      if (!(error instanceof StorageAuthorityLostError) && !(error instanceof StorageAuthorityRequiredError)) {
        diagStack("aggregate checkpoint failed", error);
      }
      throw error;
    });
    if (snapshot.session !== null) markSavedSession();
  }
  patchApplicationState(transform) {
    if (!this.hasAuthority()) throw this.authorityMutationError();
    const next = capSessionHistories(transform(structuredClone(this.root)));
    decodeDurableApplicationState(next);
    this.root = next;
    this.notifyWalletOperations();
    return structuredClone(next);
  }
  attachRuntime(runtime) {
    this.activeRuntime = runtime;
    return () => {
      if (this.activeRuntime === runtime) this.activeRuntime = null;
    };
  }
  persistDomainMutation() {
    if (this.activeRuntime) {
      this.activeRuntime.requestCommit();
      return Promise.resolve();
    }
    const write = this.write(structuredClone(this.root));
    void write.catch(() => {
    });
    return write;
  }
  checkpointDomainMutations() {
    return this.activeRuntime ? this.activeRuntime.flush() : this.write(structuredClone(this.root));
  }
  holdNextMutationForTests(barrier) {
    this.pendingMutationBarrierForTests = barrier;
  }
  holdNextCheckpointAfterCommitForTests(barrier, committed) {
    this.pendingCheckpointHoldForTests = { barrier, committed };
  }
  holdNextClaimAfterCommitForTests(barrier, claimed) {
    this.pendingClaimHoldForTests = { barrier, claimed };
  }
  authorityMutationError() {
    return this.fenced ? new StorageAuthorityLostError() : new StorageAuthorityRequiredError();
  }
  runAuthorizedMutation(write) {
    if (!this.authority || this.fenced) {
      return Promise.reject(this.authorityMutationError());
    }
    const authority = { ...this.authority };
    return this.enqueue(authority, this.generation, () => write(authority));
  }
  enqueue(authority, generation, run, allowFenced = false) {
    const lifecycle = this.lifecycle;
    const execution = this.mutationTail.then(async () => {
      const barrier = this.pendingMutationBarrierForTests;
      this.pendingMutationBarrierForTests = null;
      if (barrier) await barrier;
      await run();
      if (lifecycle !== this.lifecycle) return;
      if (!allowFenced && this.fenced || generation !== this.generation || !this.authority || this.authority.ownerTabId !== authority.ownerTabId || this.authority.writeEpoch !== authority.writeEpoch || this.authority.resetEpoch !== authority.resetEpoch) {
        throw new StorageAuthorityLostError();
      }
    });
    this.mutationTail = execution.then(
      () => {
      },
      () => {
      }
    );
    return execution.catch((error) => {
      this.handleMutationFailure(lifecycle, authority, error);
      throw error;
    });
  }
  handleMutationFailure(lifecycle, authority, error) {
    if (lifecycle !== this.lifecycle || !(error instanceof StorageAuthorityLostError)) return;
    if (this.authority?.ownerTabId === authority.ownerTabId && this.authority.writeEpoch === authority.writeEpoch && this.authority.resetEpoch === authority.resetEpoch) {
      this.loseAuthority("durable-authority-lost");
    }
  }
  stopPersistenceForHardReset() {
    this.root = newApplicationState();
    if (!this.fenced) this.loseAuthority("durable-authority-lost");
    this.activeRuntime = null;
  }
  root = newApplicationState();
  hasResumableState(state = this.root) {
    return !!(state.preferences.blockchainType || state.preferences.hubUrl) || hasWalletConnectStorage() || state.session !== null || state.channelFundingOperations.length > 0 || state.feeAttachments.length > 0 || state.rejectionTransports.length > 0;
  }
  constructor() {
    installStorageCoordination(
      (reason) => this.loseAuthority(reason),
      () => this.stopPersistenceForHardReset()
    );
  }
  preAuthorityCommonPatch = {};
  _resetForTests() {
    this.lifecycle += 1;
    this.authority = null;
    this.generation += 1;
    this.claimSequence += 1;
    this.fenced = false;
    this.mutationTail = Promise.resolve();
    this.authorityLostListeners.clear();
    this.walletOperationListeners.clear();
    this.lifecycleListeners.clear();
    this.pendingMutationBarrierForTests = null;
    this.pendingCheckpointHoldForTests = null;
    this.pendingClaimHoldForTests = null;
    this.activeRuntime = null;
    this.root = newApplicationState();
    this.preAuthorityCommonPatch = {};
    resetStorageCoordinationForTests();
  }
  loadState() {
    return this.root;
  }
  channelFundingOperations() {
    return structuredClone(this.root.channelFundingOperations);
  }
  retireSessionWalletReservations(peerSessionId) {
    this.patchApplicationState((state) => retireWalletReservations(state, peerSessionId));
  }
  feeAttachments() {
    return structuredClone(this.root.feeAttachments);
  }
  ensureWalletContext(context) {
    if (!this.hasAuthority()) throw this.authorityMutationError();
    if (this.root.walletContext) return;
    this.setWalletContext(context);
  }
  setWalletContext(context) {
    if (!this.hasAuthority()) throw this.authorityMutationError();
    if (this.root.walletContext && providerScopeKey(this.root.walletContext) === providerScopeKey(context))
      return;
    this.root = { ...this.root, walletContext: structuredClone(context) };
    void this.persistDomainMutation().catch(() => {
    });
  }
  _replaceApplicationStateForTests(state) {
    decodeDurableApplicationState(state);
    this.root = structuredClone(state);
  }
  replaceChannelFunding(entries) {
    if (!this.hasAuthority()) throw this.authorityMutationError();
    if (!this.root.walletContext && entries.length) {
      throw new Error("Internal wallet consistency error: operations require walletContext");
    }
    this.root = { ...this.root, channelFundingOperations: structuredClone([...entries]) };
    this.notifyWalletOperations();
    void this.persistDomainMutation().catch(() => {
    });
  }
  replaceFeeAttachments(entries) {
    if (!this.hasAuthority()) throw this.authorityMutationError();
    if (!this.root.walletContext && entries.length) {
      throw new Error("Internal wallet consistency error: fee attachments require walletContext");
    }
    this.root = { ...this.root, feeAttachments: structuredClone([...entries]) };
    this.notifyWalletOperations();
    void this.persistDomainMutation().catch(() => {
    });
  }
  async installClaimedApplicationState(snapshot) {
    if (snapshot.applicationStateError) throw snapshot.applicationStateError;
    const record = snapshot.applicationState;
    const patch = this.preAuthorityCommonPatch;
    this.preAuthorityCommonPatch = {};
    this.root = mergeClaimedSession(record, this.root, patch);
    const retiredWalletOperations = (this.root.session === null || this.root.session.phase === "terminal") && (this.root.feeAttachments.length > 0 || this.root.channelFundingOperations.length > 0);
    if (retiredWalletOperations) this.root = retireWalletReservations(this.root);
    const restoredFees = this.root.feeAttachments.map(
      (entry) => entry.stage === "reserved" ? {
        ...entry,
        stage: "cancel-required",
        reason: "orphaned-fee-reservation-restored"
      } : entry
    );
    const feesChanged = restoredFees.some(
      (entry, index) => entry !== this.root.feeAttachments[index]
    );
    this.root = {
      ...this.root,
      feeAttachments: restoredFees
    };
    const hasPatch = Object.keys(patch).length > 0 || feesChanged || retiredWalletOperations;
    if (hasPatch) {
      try {
        await this.write(structuredClone(this.root));
      } catch (error) {
        if (error instanceof StorageAuthorityLostError) throw error;
      }
    }
    if (this.hasResumableState(this.root)) markSavedSession();
    else clearSavedSessionMarker();
    this.notifyLifecycle("claim");
    return structuredClone(this.root);
  }
  async claimApplicationState() {
    const snapshot = await this.claimAndRead(getStorageTabId());
    markLeaseClaimed();
    return this.installClaimedApplicationState(snapshot);
  }
  mutateCommon(fn) {
    if (!this.hasAuthority()) {
      const state = this.loadState();
      const before = structuredClone(state);
      this.root = fn(state);
      const patch = commonPatch(before, this.root);
      this.preAuthorityCommonPatch = {
        identity: { ...this.preAuthorityCommonPatch.identity, ...patch.identity },
        preferences: { ...this.preAuthorityCommonPatch.preferences, ...patch.preferences },
        history: { ...this.preAuthorityCommonPatch.history, ...patch.history }
      };
      return Promise.resolve();
    }
    return this.mutateSession(fn);
  }
  mutateSession(fn) {
    if (!this.hasAuthority()) return Promise.reject(this.authorityMutationError());
    this.root = fn(this.root);
    return this.persistDomainMutation();
  }
  getPlayerId() {
    return this.root.identity.playerId;
  }
  async ensureHubIdentity() {
    if (!this.hasAuthority()) {
      throw new Error("Hub identity cannot be minted before durable storage authority is claimed");
    }
    return this.getSessionId();
  }
  query(key) {
    return selectSessionPreference(this.loadState(), key);
  }
  updatePreference(update) {
    const persisted = this.mutateCommon(
      (state) => applySessionPreferenceUpdate(state, update)
    );
    if (update.key === "hubUrl" && update.value) markSavedSession();
    return persisted;
  }
  getSessionId() {
    const state = this.loadState();
    if (state.identity.sessionId) return state.identity.sessionId;
    if (!this.hasAuthority()) {
      throw new Error(
        "getSessionId called before ensureHubIdentity and durable storage authority was claimed"
      );
    }
    const sessionId = randomHex();
    this.root = {
      ...state,
      identity: { ...state.identity, sessionId }
    };
    void this.persistDomainMutation().catch(() => {
    });
    return sessionId;
  }
  regenerateSessionId() {
    const state = this.loadState();
    const sessionId = randomHex();
    this.root = {
      ...state,
      identity: { ...state.identity, sessionId, myHubPlayerId: void 0 }
    };
    if (this.hasAuthority()) {
      void this.persistDomainMutation().catch(() => {
      });
    } else {
      this.preAuthorityCommonPatch.identity = {
        ...this.preAuthorityCommonPatch.identity,
        sessionId,
        myHubPlayerId: void 0
      };
    }
    return sessionId;
  }
  clearHubIdentity() {
    void this.mutateCommon((state) => ({
      ...state,
      identity: { ...state.identity, sessionId: void 0, myHubPlayerId: void 0 }
    }));
  }
  updateCommon(patch) {
    return this.mutateCommon((state) => applyCommonPatch(state, patch));
  }
  patchPreHandshakeTransport(transport) {
    return this.mutateSession((state) => patchSessionTransport(state, transport));
  }
  persistRejectionTransport(tombstone) {
    const snapshot = this.patchApplicationState((state) => {
      const session = state.session;
      const matchesRejectedSession = (session?.phase === "live" || session?.phase === "pre-handshake") && session.pairing.peerId === tombstone.peerId && session.pairing.gameSessionId === tombstone.sessionId;
      const next = matchesRejectedSession ? freshSessionState(state) : state;
      return {
        ...next,
        rejectionTransports: retainRejectionTransport(next.rejectionTransports, tombstone)
      };
    });
    return this.write(snapshot);
  }
  clearSessionPairing() {
    return this.mutateSession(clearSessionPeer);
  }
  async readCurrentState() {
    if (!this.hasAuthority()) {
      const { applicationState, applicationStateError } = await this.inspect();
      if (applicationStateError) throw applicationStateError;
      if (applicationState && this.hasResumableState(applicationState)) {
        markSavedSession();
        return structuredClone(applicationState);
      }
      clearSavedSessionMarker();
      return null;
    }
    if (this.hasResumableState(this.root)) {
      markSavedSession();
      return structuredClone(this.root);
    }
    clearSavedSessionMarker();
    return null;
  }
  clearSession() {
    if (!this.hasAuthority()) return Promise.reject(this.authorityMutationError());
    this.patchApplicationState(
      (state) => freshSessionState(retireWalletReservations(state))
    );
    const deletePromise = this.write(structuredClone(this.root)).then(() => {
      if (this.root.preferences.blockchainType || this.root.preferences.hubUrl || this.root.channelFundingOperations.length > 0 || this.root.feeAttachments.length > 0) {
        markSavedSession();
      } else {
        clearSavedSessionMarker();
      }
    });
    return deletePromise;
  }
  async hardReset() {
    const { hardResetStorage: hardResetStorage2, hardResetUnclaimedStorage: hardResetUnclaimedStorage2 } = await import("./saveHardReset-3265ZKOE.js");
    if (!this.hasAuthority()) {
      this.root = newApplicationState();
      this.activeRuntime = null;
      return hardResetUnclaimedStorage2();
    }
    const authority = await this.beginHardReset(getStorageTabId());
    this.stopPersistenceForHardReset();
    return hardResetStorage2(authority, (owned, reset) => this.hardResetMutation(owned, reset));
  }
  getOrCreateAlias() {
    const state = this.loadState();
    const existing = selectSessionPreference(state, "alias");
    if (existing) return existing;
    const generated = `Player_${randomHex().substring(0, 8)}`;
    if (this.hasAuthority()) {
      void this.updatePreference({ key: "alias", value: generated });
    } else {
      this.root = applySessionPreferenceUpdate(state, {
        key: "alias",
        value: generated
      });
      this.preAuthorityCommonPatch.preferences = {
        ...this.preAuthorityCommonPatch.preferences,
        alias: generated
      };
    }
    return generated;
  }
};
var storageRepository = new StorageRepository();

// src/constants/currency.ts
function readNetworkIsTestnet() {
  return storageRepository.query("network") === "testnet";
}
function isTestnet() {
  return readNetworkIsTestnet();
}
function getCurrencyLabels() {
  const t = readNetworkIsTestnet();
  return {
    xch: t ? "TXCH" : "XCH",
    chia: t ? "TXCH" : "chia",
    mojo: t ? "TMojo" : "mojo",
    mojos: t ? "TMojos" : "mojos",
    MOJO: t ? "TMOJO" : "MOJO"
  };
}

// src/util.ts
function toUint8(s) {
  if (s.length % 2 != 0) {
    throw "Odd length hex string";
  }
  const result = new Uint8Array(s.length >> 1);
  for (let i = 0; i < s.length; i += 2) {
    const sub = s.slice(i, i + 2);
    const val = parseInt(sub, 16);
    result[i >> 1] = val;
  }
  return result;
}
function toHexString(byteArray) {
  return Array.from(byteArray, function(byte) {
    return ("0" + (byte & 255).toString(16)).slice(-2);
  }).join("");
}
async function coinIdFromBytes(coin) {
  const bytes = Uint8Array.from(coin);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return toHexString(new Uint8Array(hash));
}
function coerceToBytes(value) {
  if (value == null) return null;
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (ArrayBuffer.isView(value)) {
    const view = value;
    return Uint8Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value, (b) => Number(b) & 255);
  }
  if (typeof value === "object") {
    const record = value;
    const keys = Object.keys(record);
    if (keys.length === 0) return null;
    const indices = keys.map((k) => Number(k));
    if (indices.some((i) => !Number.isInteger(i) || i < 0)) return null;
    const out = new Uint8Array(Math.max(...indices) + 1);
    for (const k of keys) {
      out[Number(k)] = Number(record[k]) & 255;
    }
    return out;
  }
  return null;
}
function normalizeHexString(hex) {
  return hex.trim().toLowerCase().replace(/^0x/, "");
}
function normalizeCoinStringHex(coinString) {
  const normalized = coinString.trim().toLowerCase().replace(/0x/g, "");
  if (normalized.length % 2 !== 0) {
    throw new Error(`Invalid coin hex length: ${normalized.length}`);
  }
  return normalized;
}
function clvm_enlist(clvms) {
  const result = [];
  for (const clvm of clvms) {
    result.push("ff");
    result.push(clvm);
  }
  result.push("80");
  return result.join("");
}
function clvm_length(atom) {
  const byteLen = atom.length / 2;
  if (byteLen <= 63) {
    const alen = (byteLen | 128).toString(16).padStart(2, "0");
    return alen + atom;
  } else {
    const alen = (byteLen | 49152).toString(16).padStart(4, "0");
    return alen + atom;
  }
}
function spend_to_clvm(spend) {
  const spend_clvm = clvm_enlist([spend.puzzle, spend.solution, clvm_length(spend.signature)]);
  return spend_clvm;
}
function coin_spend_to_clvm(coinspend) {
  const coin_spend_clvm = clvm_enlist([
    clvm_length(coinspend.coin),
    spend_to_clvm(coinspend.bundle)
  ]);
  return coin_spend_clvm;
}
function spend_bundle_to_clvm(sbundle) {
  const bundle_clvm = clvm_enlist(sbundle.spends.map((s) => coin_spend_to_clvm(s)));
  return bundle_clvm;
}
function formatMojos(mojos) {
  const labels = getCurrencyLabels();
  const trillion = 1000000000000n;
  const absMojos = mojos < 0n ? -mojos : mojos;
  if (absMojos >= 100000000n) {
    const sign = mojos < 0n ? "-" : "";
    const whole = absMojos / trillion;
    const frac = absMojos % trillion;
    const fracStr = frac.toString().padStart(12, "0").slice(0, 4).replace(/0+$/, "");
    const decimal = fracStr ? `.${fracStr}` : "";
    return `${sign}${whole.toLocaleString()}${decimal} ${labels.xch}`;
  }
  return `${mojos.toLocaleString()} ${labels.mojos}`;
}
function encodeU64AsClvmHex(val) {
  if (val === 0n) return "";
  const bytes = [];
  let h = val;
  while (h > 0n) {
    bytes.push(Number(h & 0xffn));
    h >>= 8n;
  }
  bytes.reverse();
  if (bytes[0] & 128) bytes.unshift(0);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// src/lib/session/composeDraft.ts
function emptyComposeDraftState() {
  return {
    selectedGame: DEFAULT_CATALOG_GAME_TYPE,
    gameTimeout: 15n,
    proposalSent: false
  };
}
function createComposeDraftState(lastHandProposal) {
  return {
    selectedGame: lastHandProposal.gameType,
    gameTimeout: lastHandProposal.gameTimeout,
    proposalSent: false
  };
}
function applyHandProposalToComposeDraft(state, handProposal) {
  if (handProposal === null) return state;
  return {
    ...state,
    selectedGame: handProposal.gameType,
    gameTimeout: handProposal.gameTimeout,
    proposalSent: false
  };
}
function selectComposeGame(state, selectedGame) {
  return { ...state, selectedGame };
}

// src/lib/session/normalization.ts
var INITIAL_CHANNEL_STATUS_MODEL = {
  state: "Handshaking",
  sessionDisposition: null,
  advisory: null,
  coin: null,
  coinHex: null,
  coinAmount: null,
  ourBalance: null,
  theirBalance: null,
  gameAllocated: null,
  havePotato: null,
  zeroPayout: null,
  unrollInitiator: null,
  semanticPhase: null,
  stateNumber: null,
  unrollingStateNumber: null,
  preemptingStateNumber: null
};
var DEFAULT_GAME_TIMEOUT_BLOCKS = 15n;
var DEFAULT_CHANNEL_TIMEOUT_BLOCKS = 15n;
var DEFAULT_UNROLL_TIMEOUT_BLOCKS = 15n;
function parseChannelAmount(coin) {
  const bytes = coerceToBytes(coin);
  if (!bytes || bytes.length < 64) return null;
  let value = 0n;
  for (let i = 64; i < bytes.length; i += 1) value = (value << 8n) + BigInt(bytes[i] & 255);
  return value.toString();
}
function parseAmount2(value) {
  if (value == null) return null;
  return typeof value === "object" && "Amount" in value ? String(value.Amount) : String(value);
}
function channelStatusModelFromPayload(status) {
  const coinAmount = parseChannelAmount(status.coin);
  const resolved = status.state === "ResolvedUnrolled" || status.state === "ResolvedStale";
  return {
    state: status.state,
    sessionDisposition: status.session_disposition ?? null,
    advisory: status.advisory ?? null,
    coin: coerceToBytes(status.coin),
    coinHex: null,
    coinAmount,
    ourBalance: resolved ? coinAmount ?? "0" : parseAmount2(status.our_balance),
    theirBalance: parseAmount2(status.their_balance),
    gameAllocated: parseAmount2(status.game_allocated),
    havePotato: status.have_potato ?? null,
    zeroPayout: status.zero_payout ?? null,
    unrollInitiator: status.unroll_initiator ?? null,
    semanticPhase: status.semantic_phase ?? null,
    stateNumber: status.state_number ?? null,
    unrollingStateNumber: status.unrolling_state_number ?? null,
    preemptingStateNumber: status.preempting_state_number ?? null
  };
}
function channelStatusPayloadFromModel(status) {
  return {
    state: status.state,
    session_disposition: status.sessionDisposition ?? null,
    advisory: status.advisory ?? null,
    coin: status.coin ?? null,
    our_balance: status.ourBalance ?? null,
    their_balance: status.theirBalance ?? null,
    game_allocated: status.gameAllocated ?? null,
    have_potato: status.havePotato ?? null,
    zero_payout: status.zeroPayout ?? null,
    unroll_initiator: status.unrollInitiator ?? null,
    semantic_phase: status.semanticPhase ?? null,
    state_number: status.stateNumber ?? null,
    unrolling_state_number: status.unrollingStateNumber ?? null,
    preempting_state_number: status.preemptingStateNumber ?? null
  };
}
function createSessionModel(partial = {}) {
  const game = partial.game ?? {};
  return {
    restore: {
      restoring: false,
      status: "idle",
      error: null,
      ...partial.restore
    },
    peer: { connected: null, ...partial.peer },
    channel: {
      status: INITIAL_CHANNEL_STATUS_MODEL,
      connection: { stateIdentifier: "starting", stateDetail: ["before handshake"] },
      cleanShutdownStarted: false,
      dismissedChannelStatus: null,
      queue: [],
      ...partial.channel
    },
    game: {
      handKey: 0,
      activeIds: [],
      currentHandIds: [],
      currentHandOrigin: null,
      lastDisplayedId: null,
      activeGameType: DEFAULT_CATALOG_GAME_TYPE,
      handState: null,
      queue: [],
      ...game,
      instances: game.instances ?? {}
    },
    betweenHand: {
      mode: "decision",
      pendingProposals: [],
      rejectedOnceHandProposal: null,
      lastHandProposal: null,
      compose: emptyComposeDraftState(),
      newHandRequested: false,
      pendingRetryHandProposal: null,
      ...partial.betweenHand
    },
    history: {
      humanHistory: [],
      wasmNotificationHistory: [],
      ...partial.history,
      diagnosticLog: recentDiagnosticEntries(partial.history?.diagnosticLog ?? [])
    }
  };
}
function normalizeSessionPresentation(model) {
  if (model.channel.status.sessionDisposition !== "Abandoned") return model;
  return {
    ...model,
    game: {
      ...model.game,
      handKey: 0,
      activeIds: [],
      currentHandIds: [],
      currentHandOrigin: null,
      instances: {},
      lastDisplayedId: null,
      handState: null
    }
  };
}
var RESOLVED_CHANNEL_STATES = /* @__PURE__ */ new Set([
  "ResolvedClean",
  "ResolvedUnrolled",
  "ResolvedStale",
  "Failed"
]);
var WINDING_DOWN_CHANNEL_STATES = /* @__PURE__ */ new Set([
  "ShutdownTransactionPending",
  "GoingOnChain",
  "Unrolling",
  "ResolvedClean",
  "ResolvedUnrolled",
  "ResolvedStale",
  "Failed"
]);

// src/lib/session/types.ts
var EMPTY_GAME_TERMINAL_MODEL = {
  type: "none",
  outcome: null,
  label: null,
  myReward: null,
  rewardCoinHex: null
};

// src/lib/session/presentation.ts
var DEFAULT_GAME_COIN_MODEL = { coinHex: null, turnState: "my-turn" };
var ON_CHAIN_CHANNEL_STATES = /* @__PURE__ */ new Set([
  "GoingOnChain",
  "Unrolling",
  "ResolvedClean",
  "ResolvedUnrolled",
  "ResolvedStale"
]);
function isTerminalGameStatus(status) {
  return status === "ended-cancelled" || status === "ended-error";
}
function isFinishingGameStatus(status, gameFinished) {
  return gameFinished === true && ["my-turn", "their-turn", "on-chain-my-turn", "on-chain-their-turn"].includes(status);
}
function projectGameStatus({
  previous,
  payload,
  channelState
}) {
  if (previous.presentation === "ended") return previous;
  const { status } = payload;
  const finishing = isFinishingGameStatus(status, payload.other_params?.game_finished);
  const preserveLocal = ON_CHAIN_CHANNEL_STATES.has(channelState) && (status === "my-turn" || status === "their-turn");
  const coinHex = payload.coin_id != null ? null : previous.coinHex;
  if (preserveLocal || status === "on-chain-my-turn" && (previous.presentation === "playing-move" || previous.presentation === "replaying-move")) {
    return coinHex === previous.coinHex ? previous : { ...previous, coinHex };
  }
  let presentation;
  if (status === "finishing-waiting-timeout") {
    presentation = "finishing-waiting-timeout";
  } else if (status === "finishing-spending") {
    presentation = "finishing-spending";
  } else if (status === "my-turn" || status === "on-chain-my-turn") {
    presentation = finishing ? "finishing" : status === "on-chain-my-turn" ? "on-chain-my-turn" : "off-chain-my-turn";
  } else if (status === "their-turn" || status === "on-chain-their-turn") {
    const timeout = payload.other_params?.submitting_timeout_claim === true;
    presentation = finishing ? "finishing" : timeout ? "submitting-timeout" : status === "on-chain-their-turn" ? "on-chain-their-turn" : "off-chain-their-turn";
  } else if (status === "replaying") {
    presentation = "replaying-move";
  } else if (status === "playing-move") {
    presentation = "playing-move";
  } else if (status === "illegal-move-detected") {
    presentation = "illegal-move";
  } else {
    throw new Error(`Unexpected game status: ${String(status)}`);
  }
  return presentation === previous.presentation && coinHex === previous.coinHex ? previous : { ...previous, coinHex, presentation };
}
function nextGameInstanceAfterLocalTurn(instance, isMyTurn, channelState) {
  if (ON_CHAIN_CHANNEL_STATES.has(channelState) || instance.presentation !== "off-chain-my-turn" && instance.presentation !== "off-chain-their-turn") {
    return instance;
  }
  const presentation = isMyTurn ? "off-chain-my-turn" : "off-chain-their-turn";
  return presentation === instance.presentation ? instance : { ...instance, presentation };
}
function gameInstanceView(instance) {
  const base = { id: instance.id, amount: instance.amount, terminal: instance.terminal };
  const mapping = {
    "off-chain-my-turn": {
      coin: { coinHex: instance.coinHex, turnState: "my-turn", onChain: false },
      handStatus: "active"
    },
    "off-chain-their-turn": {
      coin: { coinHex: instance.coinHex, turnState: "their-turn", onChain: false },
      handStatus: "active"
    },
    "on-chain-my-turn": {
      coin: { coinHex: instance.coinHex, turnState: "my-turn", onChain: true },
      handStatus: "our-turn"
    },
    "on-chain-their-turn": {
      coin: { coinHex: instance.coinHex, turnState: "their-turn", onChain: true },
      handStatus: "their-turn"
    },
    "playing-move": {
      coin: { coinHex: instance.coinHex, turnState: "playing-on-chain", onChain: true },
      handStatus: "playing-move"
    },
    "replaying-move": {
      coin: { coinHex: instance.coinHex, turnState: "replaying", onChain: true },
      handStatus: "replaying-move"
    },
    "illegal-move": {
      coin: { coinHex: instance.coinHex, turnState: "opponent-illegal-move", onChain: true },
      handStatus: "slashing"
    },
    "submitting-timeout": {
      coin: { coinHex: instance.coinHex, turnState: "submitting-timeout", onChain: true },
      handStatus: "submitting-timeout"
    },
    finishing: {
      coin: { coinHex: instance.coinHex, turnState: "finishing" },
      handStatus: "finishing"
    },
    "finishing-waiting-timeout": {
      coin: {
        coinHex: instance.coinHex,
        turnState: "finishing-waiting-timeout",
        onChain: true
      },
      handStatus: "finishing-waiting-timeout"
    },
    "finishing-spending": {
      coin: { coinHex: instance.coinHex, turnState: "finishing-spending", onChain: true },
      handStatus: "finishing-spending"
    },
    ended: { coin: { coinHex: instance.coinHex, turnState: "ended" }, handStatus: "ended" }
  };
  return { ...base, ...mapping[instance.presentation] };
}
var finishingUnrollLabel = (opponent) => opponent ? "Finishing opponent unroll" : "Finishing unroll";
var UNROLL_PHASE_LABEL = {
  submitting_channel_spend: () => null,
  unrolling: () => "Unrolling",
  finding_state: (opponent) => opponent ? "Opponent unrolled" : "Unrolled",
  preempting: () => "Preempting",
  finishing_waiting_timeout: finishingUnrollLabel,
  finishing_spending: finishingUnrollLabel,
  resolving: () => null
};
var UNROLL_PHASE_DETAIL = {
  submitting_channel_spend: () => "Submitting channel spend",
  unrolling: (channel) => channel.unrollingStateNumber != null ? `to state ${channel.unrollingStateNumber}` : null,
  finding_state: () => "finding state",
  preempting: (channel) => {
    const landed = channel.unrollingStateNumber;
    const preempting = channel.preemptingStateNumber;
    if (landed != null && preempting != null) return `from ${landed} to ${preempting}`;
    if (landed != null) return `from ${landed}`;
    return null;
  },
  finishing_waiting_timeout: (channel) => channel.unrollingStateNumber != null ? `waiting for timeout state ${channel.unrollingStateNumber}` : "waiting for timeout",
  finishing_spending: (channel) => channel.unrollingStateNumber != null ? `spending state ${channel.unrollingStateNumber}` : null,
  resolving: () => "Resolving"
};
function unrollActionLabel(channel) {
  return channel.semanticPhase ? UNROLL_PHASE_LABEL[channel.semanticPhase](channel.unrollInitiator === "opponent") : null;
}
function unrollActionDetail(channel) {
  return channel.semanticPhase ? UNROLL_PHASE_DETAIL[channel.semanticPhase](channel) : null;
}

// src/lib/session/proposalPolicy.ts
function isUncancelledProposalLifecycle(lifecycle) {
  return lifecycle !== "local-cancel-queued" && lifecycle !== "peer-cancel-queued";
}
function isUncancelledProposal(proposal) {
  return isUncancelledProposalLifecycle(proposal.lifecycle);
}

// src/lib/session/sessionMachineProposals.ts
function proposalOrigin(proposal) {
  return proposal.lifecycle.startsWith("local-") ? "local" : "peer";
}
function clearProposalIds(state, requestedIds) {
  const betweenHand = state.model.betweenHand;
  const tracked = requestedIds ? new Set(requestedIds) : null;
  return {
    ...state,
    model: {
      ...state.model,
      betweenHand: {
        ...betweenHand,
        pendingProposals: tracked ? betweenHand.pendingProposals.filter((proposal) => !tracked.has(proposal.id)) : []
      }
    }
  };
}
function assertNever(event) {
  throw new Error(`Unhandled proposal event: ${JSON.stringify(event)}`);
}
function reduceProposalEvent(state, event) {
  switch (event.type) {
    case "upsert-pending-proposal": {
      const proposals = state.model.betweenHand.pendingProposals;
      const existing = proposals.findIndex((proposal) => proposal.id === event.proposal.id);
      const pendingProposals = existing < 0 ? [...proposals, event.proposal] : proposals.map((proposal, index) => index === existing ? event.proposal : proposal);
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: { ...state.model.betweenHand, pendingProposals }
          }
        },
        effects: []
      };
    }
    case "set-proposal-lifecycle":
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: {
              ...state.model.betweenHand,
              pendingProposals: state.model.betweenHand.pendingProposals.map(
                (proposal) => proposal.id === event.id ? { ...proposal, lifecycle: event.lifecycle } : proposal
              )
            }
          }
        },
        effects: []
      };
    case "clear-proposals":
      return { state: clearProposalIds(state, event.ids), effects: [] };
    case "request-accept-proposal":
      return { state, effects: [{ type: "controller-accept-proposal", id: event.id }] };
    case "request-cancel-proposal":
      return { state, effects: [{ type: "controller-cancel-proposal", id: event.id }] };
    case "request-propose-game":
      if (state.model.betweenHand.pendingProposals.some(isUncancelledProposal)) {
        return { state, effects: [] };
      }
      return {
        state,
        effects: [{ type: "controller-propose-game", handProposal: event.handProposal }]
      };
    case "proposal-sent": {
      const proposal = {
        id: event.id,
        handProposal: event.handProposal,
        lifecycle: "local-outgoing"
      };
      const tracked = reduceProposalEvent(state, { type: "upsert-pending-proposal", proposal });
      return {
        state: {
          ...tracked.state,
          model: {
            ...tracked.state.model,
            betweenHand: {
              ...tracked.state.model.betweenHand,
              compose: { ...tracked.state.model.betweenHand.compose, proposalSent: true }
            }
          }
        },
        effects: []
      };
    }
    case "proposal-command-succeeded": {
      const betweenHand = state.model.betweenHand;
      const proposal = betweenHand.pendingProposals.find(({ id }) => id === event.id);
      if (!proposal) {
        if (event.command === "cancel-proposal") {
          return { state, effects: [] };
        }
        throw new Error(`Proposal command succeeded for unknown proposal ${event.id}`);
      }
      if (event.command === "accept-proposal") {
        if (proposal.lifecycle === "peer-review") {
          return {
            state: {
              ...state,
              model: {
                ...state.model,
                betweenHand: {
                  ...betweenHand,
                  pendingProposals: betweenHand.pendingProposals.map(
                    (proposal2) => proposal2.id === event.id ? { ...proposal2, lifecycle: "peer-accept-queued" } : proposal2
                  )
                }
              }
            },
            effects: []
          };
        }
        if (proposal.lifecycle === "peer-cached") {
          return {
            state: {
              ...state,
              model: {
                ...state.model,
                betweenHand: {
                  ...betweenHand,
                  newHandRequested: false,
                  pendingProposals: betweenHand.pendingProposals.map(
                    (proposal2) => proposal2.id === event.id ? { ...proposal2, lifecycle: "peer-accept-queued" } : proposal2
                  )
                }
              }
            },
            effects: []
          };
        }
        throw new Error(
          `Accept command succeeded from invalid proposal lifecycle ${proposal.lifecycle}`
        );
      }
      if (proposal.lifecycle === "peer-cached") {
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                pendingProposals: betweenHand.pendingProposals.filter(
                  (proposal2) => proposal2.id !== event.id
                ),
                rejectedOnceHandProposal: betweenHand.lastHandProposal,
                compose: applyHandProposalToComposeDraft(
                  betweenHand.compose,
                  betweenHand.lastHandProposal
                ),
                mode: "compose-proposal"
              }
            }
          },
          effects: []
        };
      }
      if (proposal.lifecycle === "peer-review") {
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                pendingProposals: betweenHand.pendingProposals.filter(
                  (proposal2) => proposal2.id !== event.id
                ),
                compose: { ...betweenHand.compose, proposalSent: false },
                mode: "compose-proposal"
              }
            }
          },
          effects: []
        };
      }
      if (proposal.lifecycle === "peer-cancel-queued") {
        return { state: clearProposalIds(state, [event.id]), effects: [] };
      }
      if (proposal.lifecycle === "local-outgoing") {
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                pendingProposals: betweenHand.pendingProposals.map(
                  (candidate) => candidate.id === event.id ? { ...candidate, lifecycle: "local-cancel-queued" } : candidate
                )
              }
            }
          },
          effects: []
        };
      }
      throw new Error(
        `Cancel command succeeded from invalid proposal lifecycle ${proposal.lifecycle}`
      );
    }
    default:
      return assertNever(event);
  }
}

// src/lib/session/selectors.ts
var EMPTY_DASHBOARD_VIEW_BASE = {
  channelDetail: null,
  havePotato: false,
  handStatusLabel: "No hand",
  handDetail: null,
  lifecycleRows: []
};
function selectPendingProposal(model, id) {
  return model.betweenHand.pendingProposals.find((proposal) => proposal.id === id) ?? null;
}
function selectProposalByLifecycle(model, lifecycle) {
  return model.betweenHand.pendingProposals.find((proposal) => proposal.lifecycle === lifecycle) ?? null;
}
function selectIncomingProposal(model) {
  return selectProposalByLifecycle(model, "peer-review") ?? selectProposalByLifecycle(model, "peer-cached") ?? selectProposalByLifecycle(model, "peer-accept-queued") ?? null;
}
function selectIProposedHand(model) {
  if (model.game.currentHandOrigin !== null) {
    return model.game.currentHandOrigin === "local";
  }
  if (model.game.currentHandIds.length > 0) {
    throw new Error("Game model invariant broken: current hand is missing its origin");
  }
  const proposal = selectProposalByLifecycle(model, "peer-review") ?? selectProposalByLifecycle(model, "peer-cached") ?? selectProposalByLifecycle(model, "peer-accept-queued") ?? selectProposalByLifecycle(model, "local-outgoing") ?? selectProposalByLifecycle(model, "local-cancel-queued");
  return proposal ? proposalOrigin(proposal) === "local" : false;
}
var UNROLL_COMPLETED_HAND_STATES = /* @__PURE__ */ new Set(["ResolvedUnrolled", "ResolvedStale"]);
var PRE_ACTIVE_CHANNEL_STATES = /* @__PURE__ */ new Set([
  "Handshaking",
  "WaitingForHeightToOffer",
  "WaitingForHeightToAccept",
  "OurWalletMakingOffer",
  "OurWalletMakingOfferAcceptance",
  "OfferSent",
  "TransactionPending"
]);
function isTerminalChannelSnapshot(status) {
  const sessionDisposition = status && ("sessionDisposition" in status ? status.sessionDisposition : status.session_disposition);
  return sessionDisposition !== "AwaitOutboundTerminal" && (sessionDisposition === "Abandoned" || status !== null && status !== void 0 && RESOLVED_CHANNEL_STATES.has(status.state));
}
var PRE_COMMITMENT_CHANNEL_STATES = /* @__PURE__ */ new Set([
  "Handshaking",
  "WaitingForHeightToOffer",
  "WaitingForHeightToAccept",
  "OurWalletMakingOffer",
  "OurWalletMakingOfferAcceptance"
]);
function isPreCommitmentChannelStatus(state) {
  return state === null || state === void 0 || PRE_COMMITMENT_CHANNEL_STATES.has(state);
}
var CHANNEL_STATUS_LABELS = {
  Handshaking: "Handshaking",
  WaitingForHeightToOffer: "Waiting For Height To Offer",
  WaitingForHeightToAccept: "Waiting For Height To Accept",
  OurWalletMakingOffer: "Our Wallet Making Offer",
  OurWalletMakingOfferAcceptance: "Our Wallet Making Offer Acceptance",
  OfferSent: "Offer Sent",
  TransactionPending: "Making Channel",
  Active: "Active",
  ShuttingDown: "Shutting Down",
  ShutdownTransactionPending: "Shutting Down",
  GoingOnChain: "Going On Chain",
  Unrolling: "Unrolling",
  ResolvedClean: "Resolved Clean",
  ResolvedUnrolled: "Resolved Unrolled",
  ResolvedStale: "Resolved Stale",
  Failed: "Failed"
};
var HAND_STATUS_LABELS = {
  none: "No hand",
  active: "Active",
  "their-turn": "Their turn",
  "our-turn": "Your turn",
  "playing-move": "Playing move",
  "replaying-move": "Replaying move",
  slashing: "Slashing cheater",
  "submitting-timeout": "Submitting timeout claim",
  finishing: "Finishing",
  "finishing-waiting-timeout": "Finalizing waiting for timeout",
  "finishing-spending": "Finalizing spending",
  ended: "Ended"
};
function isWindingDownChannelStatus(state) {
  return WINDING_DOWN_CHANNEL_STATES.has(state);
}
function selectSessionPhase(model, hostOnChain = false) {
  if (model.channel.status.sessionDisposition === "Abandoned") return "resolved";
  if (model.channel.status.sessionDisposition === "AwaitOutboundTerminal") return "off-chain";
  if ((model.channel.status.state === "ResolvedUnrolled" || model.channel.status.state === "ResolvedStale") && model.game.activeIds.length > 0) {
    return "on-chain";
  }
  if (isTerminalChannelSnapshot(model.channel.status)) return "resolved";
  if (hostOnChain) return "on-chain";
  if (model.channel.status.state === "ShutdownTransactionPending") return "off-chain";
  if (isWindingDownChannelStatus(model.channel.status.state)) {
    return "on-chain";
  }
  return "off-chain";
}
function selectRestoreBlocked(model) {
  return model.restore.restoring && model.restore.status !== "restored";
}
function selectDisplayGameId(model) {
  return model.game.activeIds[0] ?? model.game.lastDisplayedId;
}
function selectDisplayedGameInstance(model) {
  const id = selectDisplayGameId(model);
  const instance = id === null ? null : model.game.instances[id];
  return instance ? gameInstanceView(instance) : null;
}
function selectBetweenHands(model) {
  return model.game.handKey > 0 && model.game.activeIds.length === 0;
}
function selectDashboardCoins(model, coins) {
  const activeIds = new Set(model.game.activeIds);
  return coins.flatMap((coin) => {
    const gameId = coin.game_id;
    if (!gameId || !coin.game_coin_kind) return [{ ...coin }];
    if (coin.game_coin_kind === "current" && !activeIds.has(gameId)) return [];
    const handIndex = model.game.currentHandIds.indexOf(gameId);
    if (handIndex < 0) return [{ ...coin }];
    return [
      {
        ...coin,
        label: `Hand ${handIndex + 1} ${coin.game_coin_kind === "reward" ? "reward coin" : "coin"}`
      }
    ];
  });
}
function selectInertGameInterfaceForBetweenHandDialog(betweenHands, betweenHandMode, hasReviewPeerProposal, overlayIsActive) {
  return overlayIsActive && betweenHands && (betweenHandMode === "compose-proposal" || betweenHandMode === "review-incoming-proposal" && hasReviewPeerProposal);
}
function selectGameTabConnected(args) {
  const { sessionPhase, peerLiveness } = args;
  if (sessionPhase === "none" || sessionPhase === "resolved") return false;
  if (peerLiveness === "dead") return false;
  return true;
}
function isOnChainBanner(model) {
  const state = model.channel.status.state;
  if (state === "GoingOnChain" || state === "Unrolling") return true;
  return (state === "ResolvedUnrolled" || state === "ResolvedStale") && model.game.activeIds.length > 0;
}
function selectBannerTone(model, options) {
  if (options.setupPending) {
    return "playing";
  }
  if (!model || options.hasSession === false) return "idle";
  if (isOnChainBanner(model)) return "on-chain";
  if (isTerminalChannelSnapshot(model.channel.status)) return "ended";
  if (model.channel.status.state === "Handshaking" || model.channel.status.state === "ShutdownTransactionPending")
    return "playing";
  if (options.peerLiveness === "degraded") return "pings-bad";
  return "playing";
}
function channelStatusDetail(model) {
  const channel = model.channel.status;
  if (channel.sessionDisposition === "Abandoned") {
    return channel.advisory ?? "Session abandoned";
  }
  if (channel.sessionDisposition === "AwaitOutboundTerminal") {
    return channel.advisory ?? "Waiting for peer to acknowledge close";
  }
  const unrollDetail = unrollActionDetail(channel);
  if (unrollDetail) {
    return channel.advisory ? `${unrollDetail}: ${channel.advisory}` : unrollDetail;
  }
  switch (channel.state) {
    case "Active":
      if (channel.stateNumber != null) {
        const stateDetail = `state ${channel.stateNumber}`;
        return channel.advisory ? `${stateDetail}: ${channel.advisory}` : stateDetail;
      }
      return channel.advisory;
    case "Failed":
      return channel.advisory ?? model.restore.error ?? "Channel failed";
    default:
      return channel.advisory;
  }
}
function selectHandStatus(model) {
  if (model.game.activeIds.length === 0) {
    return "none";
  }
  const displayed = selectDisplayedGameInstance(model);
  const terminal = displayed?.terminal ?? EMPTY_GAME_TERMINAL_MODEL;
  const coin = displayed?.coin ?? DEFAULT_GAME_COIN_MODEL;
  if (terminal.type !== "none" || coin.turnState === "ended") {
    return "ended";
  }
  if (!UNROLL_COMPLETED_HAND_STATES.has(model.channel.status.state)) {
    return "active";
  }
  if (ON_CHAIN_CHANNEL_STATES.has(model.channel.status.state)) {
    switch (coin.turnState) {
      case "my-turn":
        return "our-turn";
      // We detected the opponent's illegal on-chain move and are now resolving
      // the slash; surface that explicitly rather than a generic "our turn".
      case "opponent-illegal-move":
        return "slashing";
      case "submitting-timeout":
        return "submitting-timeout";
      case "their-turn":
        return "their-turn";
      case "playing-on-chain":
        return "playing-move";
      case "replaying":
        return "replaying-move";
      case "finishing":
        return "finishing";
      case "finishing-waiting-timeout":
        return "finishing-waiting-timeout";
      case "finishing-spending":
        return "finishing-spending";
    }
  }
  return "active";
}
function collapsedHandStatusLabel(model) {
  return HAND_STATUS_LABELS[selectHandStatus(model)];
}
function collapsedHandDetail(model) {
  if (model.game.activeIds.length === 0) {
    return null;
  }
  const terminal = selectDisplayedGameInstance(model)?.terminal ?? EMPTY_GAME_TERMINAL_MODEL;
  if (terminal.type === "none") {
    return null;
  }
  return terminal.label;
}
function instanceHandStatus(instance) {
  if (instance.terminal.type !== "none" || instance.coin.turnState === "ended") {
    return "ended";
  }
  return instance.handStatus;
}
function instanceTerminalDetail(instance) {
  const terminal = instance.terminal;
  if (terminal.type === "none") {
    return null;
  }
  return terminal.label;
}
function selectLifecycleRows(model) {
  if (!UNROLL_COMPLETED_HAND_STATES.has(model.channel.status.state)) {
    return [];
  }
  const multiple = model.game.currentHandIds.length > 1;
  return model.game.currentHandIds.flatMap((id, index) => {
    const stored = model.game.instances[id];
    if (!stored) return [];
    const instance = gameInstanceView(stored);
    if (instance.terminal.type !== "none" || instance.coin.turnState === "ended") {
      return [];
    }
    return [
      {
        id,
        label: multiple ? `Hand ${index + 1}` : "Hand",
        statusLabel: HAND_STATUS_LABELS[instanceHandStatus(instance)],
        detail: instanceTerminalDetail(instance)
      }
    ];
  });
}
var ABANDON_WAITING_STATES = /* @__PURE__ */ new Set([
  "OfferSent",
  "TransactionPending",
  "ShutdownTransactionPending",
  "GoingOnChain",
  "Unrolling",
  "ResolvedUnrolled",
  "ResolvedStale"
]);
function isChannelAbandonable(status, abandonEnabled, hasActiveGames = false) {
  return status?.sessionDisposition !== "AwaitOutboundTerminal" && status?.sessionDisposition !== "Abandoned" && (status?.state === "ShuttingDown" && status.zeroPayout === true || abandonEnabled && status !== null && status !== void 0 && ABANDON_WAITING_STATES.has(status.state) && (!UNROLL_COMPLETED_HAND_STATES.has(status.state) || hasActiveGames));
}
function dashboardActionFor(model, cleanShutdownGraceActive, abandonEnabled) {
  if ((model.channel.status.state === "ResolvedUnrolled" || model.channel.status.state === "ResolvedStale") && model.game.activeIds.length > 0) {
    if (isChannelAbandonable(model.channel.status, abandonEnabled, true)) {
      return { actionLabel: "Abandon", actionEnabled: true, actionKind: "abandon" };
    }
    return { actionLabel: "Waiting", actionEnabled: false, actionKind: "none" };
  }
  if (isTerminalChannelSnapshot(model.channel.status)) {
    return { actionLabel: "Done", actionEnabled: false, actionKind: "none" };
  }
  if (model.channel.status.sessionDisposition === "AwaitOutboundTerminal") {
    return { actionLabel: "Waiting", actionEnabled: false, actionKind: "none" };
  }
  switch (model.channel.status.state) {
    case "Handshaking":
    case "WaitingForHeightToOffer":
    case "WaitingForHeightToAccept":
    case "OurWalletMakingOffer":
    case "OurWalletMakingOfferAcceptance":
      return { actionLabel: "Cancel", actionEnabled: true, actionKind: "cancel" };
    case "OfferSent":
    case "TransactionPending":
      if (abandonEnabled) {
        return { actionLabel: "Abandon", actionEnabled: true, actionKind: "abandon" };
      }
      return { actionLabel: "Waiting", actionEnabled: false, actionKind: "none" };
    case "Active":
      if (model.game.activeIds.length > 0) {
        return { actionLabel: "Go On-Chain", actionEnabled: true, actionKind: "go-on-chain" };
      }
      if (cleanShutdownGraceActive) {
        return { actionLabel: "Waiting", actionEnabled: false, actionKind: "none" };
      }
      return { actionLabel: "Clean Shutdown", actionEnabled: true, actionKind: "clean-shutdown" };
    case "ShuttingDown":
      if (model.channel.status.zeroPayout) {
        return { actionLabel: "Abandon", actionEnabled: true, actionKind: "abandon" };
      }
      if (cleanShutdownGraceActive) {
        return { actionLabel: "Waiting", actionEnabled: false, actionKind: "none" };
      }
      return { actionLabel: "Go On-Chain", actionEnabled: true, actionKind: "go-on-chain" };
    case "ShutdownTransactionPending":
      if (model.channel.status.zeroPayout) {
        return { actionLabel: "Waiting", actionEnabled: false, actionKind: "none" };
      }
      if (abandonEnabled) {
        return { actionLabel: "Abandon", actionEnabled: true, actionKind: "abandon" };
      }
      return { actionLabel: "Waiting", actionEnabled: false, actionKind: "none" };
    case "GoingOnChain":
    case "Unrolling":
      if (abandonEnabled) {
        return { actionLabel: "Abandon", actionEnabled: true, actionKind: "abandon" };
      }
      return { actionLabel: "Waiting", actionEnabled: false, actionKind: "none" };
    case "ResolvedClean":
    case "ResolvedUnrolled":
    case "ResolvedStale":
    case "Failed":
      return { actionLabel: "Done", actionEnabled: false, actionKind: "none" };
  }
}
function selectGameDashboardView(model, options = {}) {
  const bannerTone = selectBannerTone(model, options);
  if (options.setupPending) {
    return {
      ...EMPTY_DASHBOARD_VIEW_BASE,
      bannerTone,
      channelStatusLabel: "Setting Up",
      ...options.actionsBlocked ? {
        actionLabel: "Waiting",
        actionEnabled: false,
        actionKind: "none"
      } : { actionLabel: "Cancel", actionEnabled: true, actionKind: "cancel" }
    };
  }
  if (!model || options.hasSession === false) {
    return {
      ...EMPTY_DASHBOARD_VIEW_BASE,
      bannerTone,
      channelStatusLabel: "No Session",
      actionLabel: "No Session",
      actionEnabled: false,
      actionKind: "none"
    };
  }
  const channel = model.channel.status;
  const action = options.actionsBlocked ? {
    actionLabel: "Waiting",
    actionEnabled: false,
    actionKind: "none"
  } : dashboardActionFor(
    model,
    options.cleanShutdownGraceActive ?? false,
    options.abandonEnabled ?? false
  );
  return {
    bannerTone,
    channelStatusLabel: channel.sessionDisposition === "Abandoned" ? "Abandoned" : channel.sessionDisposition === "AwaitOutboundTerminal" ? "Waiting for Peer" : unrollActionLabel(channel) ?? CHANNEL_STATUS_LABELS[channel.state],
    channelDetail: channelStatusDetail(model),
    havePotato: channel.havePotato === true,
    handStatusLabel: collapsedHandStatusLabel(model),
    handDetail: collapsedHandDetail(model),
    lifecycleRows: selectLifecycleRows(model),
    ...action
  };
}
function selectStatusBarBalances(model) {
  if (!model) {
    return null;
  }
  const channel = model.channel.status;
  if (channel.state === "Failed") {
    return [
      { label: "Me", value: "0" },
      { label: "Opp", value: "?" }
    ];
  }
  const ours = channel.ourBalance;
  const theirs = channel.theirBalance;
  if (ours == null || theirs == null) {
    return null;
  }
  const cleanShutdown = channel.state === "ShuttingDown" || channel.state === "ShutdownTransactionPending" || channel.state === "ResolvedClean";
  if (cleanShutdown) {
    return [
      { label: "Me", value: ours },
      { label: "Opp", value: theirs }
    ];
  }
  const segments = [
    { label: "Me", value: ours },
    { label: "Opp", value: theirs }
  ];
  const onChain = ON_CHAIN_CHANNEL_STATES.has(channel.state) && channel.state !== "ResolvedClean";
  const displayedIds = onChain ? model.game.currentHandIds : model.game.activeIds;
  const multiple = model.game.currentHandIds.length > 1;
  displayedIds.forEach((id) => {
    const instance = model.game.instances[id];
    if (!instance) return;
    const handIndex = model.game.currentHandIds.indexOf(id);
    const label = multiple && handIndex >= 0 ? `Hand ${handIndex + 1}` : "Hand";
    try {
      const amount = BigInt(instance.amount);
      if (amount < 0n) return;
      if (instance.terminal.type === "none") {
        segments.push({ label, value: amount.toString() });
        return;
      }
      if (instance.terminal.myReward == null) return;
      const myReward = BigInt(instance.terminal.myReward);
      if (myReward < 0n || myReward > amount) return;
      segments.push({
        label,
        value: myReward.toString(),
        value2: (amount - myReward).toString()
      });
    } catch {
    }
  });
  return segments;
}
function selectGameSessionView(model) {
  const displayed = selectDisplayedGameInstance(model);
  return {
    channelStatus: model.channel.status,
    gameCoin: displayed?.coin ?? DEFAULT_GAME_COIN_MODEL,
    gameTerminal: displayed?.terminal ?? EMPTY_GAME_TERMINAL_MODEL,
    currentHandAmount: displayed ? BigInt(displayed.amount) : 0n,
    activeGameId: model.game.activeIds[0] ?? null,
    activeGameIds: model.game.activeIds,
    activeGameType: model.game.activeGameType,
    displayGameId: selectDisplayGameId(model),
    betweenHands: selectBetweenHands(model),
    channelQueue: model.channel.queue,
    gameQueue: model.game.queue,
    incomingProposal: selectIncomingProposal(model)
  };
}
function selectGameSpecificView(model) {
  const displayed = selectDisplayedGameInstance(model);
  return {
    gameType: model.game.activeGameType,
    displayGameId: selectDisplayGameId(model),
    handState: model.game.handState,
    turnState: displayed?.coin.turnState ?? DEFAULT_GAME_COIN_MODEL.turnState,
    terminal: displayed?.terminal ?? EMPTY_GAME_TERMINAL_MODEL,
    terminalsById: Object.fromEntries(
      Object.entries(model.game.instances).map(([id, instance]) => [id, instance.terminal])
    ),
    amountsById: Object.fromEntries(
      Object.entries(model.game.instances).map(([id, instance]) => [id, instance.amount])
    )
  };
}

// src/lib/session/persistencePrimitives.ts
function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Uint8Array) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}
function requireExactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Garbled save: unexpected ${label} field ${unexpected[0]}`);
  }
}
function requireString(value, label, allowEmpty = false) {
  if (typeof value !== "string" || !allowEmpty && value.length === 0) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}
function optionalString(value, label, allowEmpty = false) {
  return value === void 0 ? void 0 : requireString(value, label, allowEmpty);
}
function requireNullableString(value, label, allowEmpty = false) {
  return value === null ? null : requireString(value, label, allowEmpty);
}
function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`Garbled save: invalid ${label}`);
  return value;
}
function requireBigint(value, label, minimum = 0n) {
  if (typeof value !== "bigint" || value < minimum) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}
function parseDecimalString(value, label, minimum) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw new Error(`Garbled save: invalid ${label}: ${String(value)}`);
  }
  const parsed = BigInt(value);
  if (minimum !== void 0 && parsed < minimum) {
    throw new Error(`Garbled save: invalid ${label}: ${value}`);
  }
  return parsed;
}
function parseDiscriminant(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`Garbled save: invalid ${label}: ${String(value)}`);
  }
  return value;
}
function requireUniqueIds(value, label, requireNonEmpty = false) {
  if (!Array.isArray(value) || requireNonEmpty && value.length === 0 || !value.every((id) => typeof id === "string" && id.length > 0)) {
    throw new Error(`Garbled save: ${label} must contain non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`Garbled save: duplicate ${label}`);
  }
  return value;
}
function parseStringArray(value, label) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return [...value];
}

// src/lib/session/persistenceBetweenHands.ts
var COMPOSE_KEYS = /* @__PURE__ */ new Set(["selectedGame", "gameTimeout"]);
var HAND_PROPOSAL_KEYS = /* @__PURE__ */ new Set(["senderIsPlayerA", "gameTimeout", "gameType", "parameters"]);
var PENDING_PROPOSAL_KEYS = /* @__PURE__ */ new Set(["id", "lifecycle", "handProposal"]);
function parseComposeDraftState(value) {
  const saved = requireRecord(value, "betweenHandCompose");
  requireExactKeys(saved, COMPOSE_KEYS, "betweenHandCompose");
  const selectedGame = saved.selectedGame;
  if (!isCatalogGameType(selectedGame)) {
    throw new Error("Garbled save: invalid betweenHandCompose.selectedGame");
  }
  return {
    selectedGame,
    gameTimeout: requireBigint(saved.gameTimeout, "betweenHandCompose.gameTimeout")
  };
}
function parseHandProposalSnapshot(value, label) {
  const saved = requireRecord(value, label);
  requireExactKeys(saved, HAND_PROPOSAL_KEYS, label);
  const gameType = saved.gameType;
  if (!isCatalogGameType(gameType)) {
    throw new Error(`Garbled save: unknown ${label}.gameType ${String(gameType)}`);
  }
  if (!isProposalParameterValue(saved.parameters)) {
    throw new Error(`Garbled save: invalid ${label}.parameters`);
  }
  const terms = {
    gameType,
    senderIsPlayerA: requireBoolean(saved.senderIsPlayerA, `${label}.senderIsPlayerA`),
    gameTimeout: requireBigint(saved.gameTimeout, `${label}.gameTimeout`, 1n),
    parameters: saved.parameters
  };
  if (!validateHandProposal(terms)) {
    throw new Error(`Garbled save: invalid ${label} ${gameType} terms`);
  }
  return terms;
}
function parsePendingProposals(value, label) {
  if (!Array.isArray(value)) throw new Error(`Garbled save: invalid ${label}`);
  const seen = /* @__PURE__ */ new Set();
  let uncancelled = 0;
  const proposals = value.map((entry, index) => {
    const proposalLabel = `${label}[${index}]`;
    const saved = requireRecord(entry, proposalLabel);
    requireExactKeys(saved, PENDING_PROPOSAL_KEYS, proposalLabel);
    const id = requireString(saved.id, `${proposalLabel}.id`);
    if (seen.has(id)) throw new Error(`Garbled save: duplicate pending proposal ${id}`);
    seen.add(id);
    const lifecycle = saved.lifecycle;
    if (lifecycle !== "local-outgoing" && lifecycle !== "local-cancel-queued" && lifecycle !== "peer-cached" && lifecycle !== "peer-review" && lifecycle !== "peer-accept-queued" && lifecycle !== "peer-cancel-queued") {
      throw new Error(`Garbled save: invalid ${proposalLabel}.lifecycle`);
    }
    if (isUncancelledProposalLifecycle(lifecycle)) uncancelled += 1;
    const handProposal = parseHandProposalSnapshot(
      saved.handProposal,
      `${proposalLabel}.handProposal`
    );
    return {
      id,
      handProposal,
      lifecycle
    };
  });
  if (uncancelled > 1) {
    throw new Error("Garbled save: multiple uncancelled proposals");
  }
  return proposals;
}

// src/types/ChiaGaming.ts
var WASM_NOTIFICATION_TAGS = /* @__PURE__ */ new Set([
  "ChannelStatus",
  "GameStatus",
  "GameSettled",
  "ProposalMade",
  "ProposalAcceptedGroup",
  "ProposalCancelled",
  "InsufficientBalance",
  "MoveRejected",
  "ActionFailed",
  "LocalActionApplied"
]);
function requireClosedNotification(value) {
  if (typeof value !== "object" || value === null) {
    throw new Error("cradle returned a non-object notification");
  }
  const tags = Object.keys(value);
  if (tags.length !== 1 || !WASM_NOTIFICATION_TAGS.has(tags[0])) {
    throw new Error(`cradle returned an unknown notification: ${tags.join(",") || "(empty)"}`);
  }
}
function requireGameSessionEvent(event) {
  if (typeof event !== "object" || event === null) {
    throw new Error("cradle returned a non-object GameSessionEvent");
  }
  const keys = Object.keys(event);
  if (keys.length !== 1) {
    throw new Error("cradle returned a malformed GameSessionEvent");
  }
  const key = keys[0];
  const payload = event[key];
  switch (key) {
    case "OutboundMessage":
      if (!(payload instanceof Uint8Array)) {
        throw new Error("cradle returned a non-byte OutboundMessage");
      }
      return;
    case "Notification":
      requireClosedNotification(payload);
      return;
    case "Log":
    case "ClvmDiagnostic":
    case "CoinSolutionRequest":
    case "ReceiveError":
      if (typeof payload !== "string") {
        throw new Error(`cradle returned an invalid ${key} event`);
      }
      return;
    case "NeedCoinSpend":
      if (typeof payload !== "object" || payload === null) {
        throw new Error("cradle returned an invalid NeedCoinSpend event");
      }
      return;
    case "ChannelCoinConfirmed":
    case "ChannelCreationTimedOut":
      if (payload !== null) {
        throw new Error(`cradle returned an invalid ${key} event`);
      }
      return;
    default:
      throw new Error(`cradle returned an unknown GameSessionEvent: ${key}`);
  }
}
function requireWasmResult(value) {
  if (value === void 0 || typeof value !== "object" || value === null) {
    throw new Error("cradle returned no WasmResult");
  }
  if (!Array.isArray(value.events) || !Array.isArray(value.watchCoins) || !Array.isArray(value.unwatchCoins) || typeof value.actionSucceeded !== "boolean") {
    throw new Error("cradle returned an incomplete WasmResult");
  }
  value.events.forEach(requireGameSessionEvent);
  const disposition = value.disposition;
  if (typeof disposition !== "object" || disposition === null || !["active", "await-outbound-terminal", "terminal"].includes(disposition.kind)) {
    throw new Error("cradle returned an invalid WasmResult disposition");
  }
  if (disposition.kind === "await-outbound-terminal" && (typeof disposition.command !== "object" || disposition.command === null || typeof disposition.command.id !== "string" || !(disposition.command.message instanceof Uint8Array))) {
    throw new Error("cradle returned an invalid terminal handoff command");
  }
  return value;
}
var CHANNEL_SEMANTIC_PHASES = [
  "submitting_channel_spend",
  "unrolling",
  "finding_state",
  "preempting",
  "finishing_waiting_timeout",
  "finishing_spending",
  "resolving"
];

// src/lib/session/persistencePayloads.ts
var AMOUNT_KEYS = /* @__PURE__ */ new Set(["Amount"]);
var CHANNEL_STATUS_KEYS = /* @__PURE__ */ new Set([
  "state",
  "session_disposition",
  "advisory",
  "coin",
  "our_balance",
  "their_balance",
  "game_allocated",
  "have_potato",
  "zero_payout",
  "unroll_initiator",
  "semantic_phase",
  "state_number",
  "unrolling_state_number",
  "preempting_state_number"
]);
var TERMINAL_COIN_KEYS = /* @__PURE__ */ new Set(["label", "id", "game_id", "game_coin_kind"]);
var CHANNEL_STATUSES = /* @__PURE__ */ new Set([
  "Handshaking",
  "WaitingForHeightToOffer",
  "WaitingForHeightToAccept",
  "OurWalletMakingOffer",
  "OurWalletMakingOfferAcceptance",
  "OfferSent",
  "TransactionPending",
  "Active",
  "ShuttingDown",
  "ShutdownTransactionPending",
  "GoingOnChain",
  "Unrolling",
  "ResolvedClean",
  "ResolvedUnrolled",
  "ResolvedStale",
  "Failed"
]);
var BETWEEN_HAND_MODES = /* @__PURE__ */ new Set([
  "decision",
  "compose-proposal",
  "review-incoming-proposal"
]);
var SESSION_DISPOSITIONS = /* @__PURE__ */ new Set(["AwaitOutboundTerminal", "Abandoned"]);
var CHANNEL_SEMANTIC_PHASE_SET = new Set(CHANNEL_SEMANTIC_PHASES);
function validateTerminalFields(terminal, label) {
  const isNonEmpty = (value) => value !== null && value.length > 0;
  const isAmount = (value) => {
    if (value === null) return false;
    try {
      return parseDecimalString(value, label, 0n) >= 0n;
    } catch {
      return false;
    }
  };
  if (terminal.type === "none") {
    if (terminal.outcome !== null || terminal.label !== null || terminal.myReward !== null || terminal.rewardCoinHex !== null) {
      throw new Error(`Garbled save: ${label} none terminal contains outcome data`);
    }
    return;
  }
  if (!isNonEmpty(terminal.label)) {
    throw new Error(`Garbled save: ${label} terminal is missing its label`);
  }
  if (terminal.rewardCoinHex !== null && terminal.rewardCoinHex.length === 0) {
    throw new Error(`Garbled save: ${label} has an empty reward coin id`);
  }
  if (terminal.type === "settled" && !isAmount(terminal.myReward)) {
    throw new Error(`Garbled save: ${label} settled terminal has invalid reward`);
  }
  if ((terminal.type === "insufficient-balance" || terminal.type === "ended-cancelled") && (terminal.myReward !== null || terminal.rewardCoinHex !== null)) {
    throw new Error(`Garbled save: ${label} ${terminal.type} terminal contains reward data`);
  }
}
function validatePairing(pairing) {
  if (!/^[0-9a-f]{32}$/.test(pairing.gameSessionId)) {
    throw new Error("Garbled save: invalid pairing.gameSessionId");
  }
  for (const [field, minimum] of [
    ["myContribution", 0n],
    ["theirContribution", 0n],
    ["perGameAmount", 0n],
    ["channelTimeout", 1n],
    ["unrollTimeout", 1n]
  ]) {
    const value = pairing[field];
    if (value !== void 0) parseDecimalString(value, field, minimum);
  }
}
function validateTransport(transport, label) {
  const { messageNumber, remoteNumber } = transport;
  if (messageNumber < 1n || messageNumber > 0x100000000n) {
    throw new Error(`Garbled save: invalid ${label}.messageNumber`);
  }
  if (remoteNumber < 0n || remoteNumber > 0xffffffffn) {
    throw new Error(`Garbled save: invalid ${label}.remoteNumber`);
  }
  const messageIds = /* @__PURE__ */ new Set();
  transport.unackedMessages.forEach(({ msgno }) => {
    if (msgno < 1n || msgno >= messageNumber) {
      throw new Error(`Garbled save: invalid ${label}.unackedMessages msgno ${msgno}`);
    }
    if (messageIds.has(msgno)) {
      throw new Error(`Garbled save: duplicate ${label}.unackedMessages msgno ${msgno}`);
    }
    messageIds.add(msgno);
  });
  const terminalHandoff = transport.terminalHandoff;
  if (terminalHandoff !== null) {
    const { id, msgno, sent, acknowledged, message: commandMessage } = terminalHandoff;
    if (id.length === 0 || msgno < 1n || msgno >= messageNumber) {
      throw new Error(`Garbled save: invalid ${label}.terminalHandoff`);
    }
    if (acknowledged && !sent) {
      throw new Error(`Garbled save: acknowledged ${label}.terminalHandoff was never sent`);
    }
    const boundFrame = transport.unackedMessages.find((message) => message.msgno === msgno);
    if (acknowledged) {
      if (transport.unackedMessages.some((message) => message.msgno <= msgno)) {
        throw new Error(
          `Garbled save: acknowledged ${label}.terminalHandoff remains in the unacked window`
        );
      }
    } else if (!boundFrame || boundFrame.msg.length !== commandMessage.length || !boundFrame.msg.every((byte, index) => byte === commandMessage[index])) {
      throw new Error(
        `Garbled save: ${label}.terminalHandoff does not match its unacked reliable frame`
      );
    }
  }
}
function validateLive(live) {
  validateTransport(live, "live");
  if (!/^[0-9a-fA-F]{64}$/.test(live.rewardPuzzleHash)) {
    throw new Error("Garbled save: invalid live.rewardPuzzleHash");
  }
}
function validateChannelStatus(value) {
  if (value === null) return null;
  const status = requireRecord(value, "channelStatus");
  requireExactKeys(status, CHANNEL_STATUS_KEYS, "channelStatus");
  for (const required of ["advisory", "coin", "our_balance", "their_balance", "game_allocated"]) {
    if (!Object.hasOwn(status, required)) {
      throw new Error(`Garbled save: channelStatus is missing ${required}`);
    }
  }
  parseDiscriminant(status.state, CHANNEL_STATUSES, "channelStatus.state");
  if (status.session_disposition !== void 0 && status.session_disposition !== null && (typeof status.session_disposition !== "string" || !SESSION_DISPOSITIONS.has(status.session_disposition))) {
    throw new Error("Garbled save: invalid channelStatus.session_disposition");
  }
  if (status.advisory !== void 0 && status.advisory !== null) {
    requireString(status.advisory, "channelStatus.advisory", true);
  }
  if (status.coin !== void 0 && status.coin !== null) {
    if (!(status.coin instanceof Uint8Array) || status.coin.length < 64) {
      throw new Error("Garbled save: invalid channelStatus.coin");
    }
  }
  for (const field of ["our_balance", "their_balance", "game_allocated"]) {
    const amount = status[field];
    if (amount === void 0 || amount === null) continue;
    const raw = (() => {
      if (typeof amount !== "object" || Array.isArray(amount) || amount === null) return amount;
      const record = requireRecord(amount, `channelStatus.${field}`);
      requireExactKeys(record, AMOUNT_KEYS, `channelStatus.${field}`);
      return record.Amount;
    })();
    if (typeof raw === "bigint") requireBigint(raw, `channelStatus.${field}`);
    else parseDecimalString(raw, `channelStatus.${field}`, 0n);
  }
  for (const field of ["have_potato", "zero_payout"]) {
    const flag = status[field];
    if (flag !== void 0 && flag !== null) requireBoolean(flag, `channelStatus.${field}`);
  }
  if (status.unroll_initiator !== void 0 && status.unroll_initiator !== null && status.unroll_initiator !== "us" && status.unroll_initiator !== "opponent") {
    throw new Error("Garbled save: invalid channelStatus.unroll_initiator");
  }
  if (status.semantic_phase !== void 0 && status.semantic_phase !== null && (typeof status.semantic_phase !== "string" || !CHANNEL_SEMANTIC_PHASE_SET.has(status.semantic_phase))) {
    throw new Error("Garbled save: invalid channelStatus.semantic_phase");
  }
  for (const field of [
    "state_number",
    "unrolling_state_number",
    "preempting_state_number"
  ]) {
    const value2 = status[field];
    if (value2 === void 0 || value2 === null) continue;
    requireBigint(value2, `channelStatus.${field}`);
  }
  return status;
}
function decodeTerminalCoins(value) {
  if (!Array.isArray(value)) {
    throw new Error("Garbled save: terminal phase is missing coinsOfInterest");
  }
  const coinIds = /* @__PURE__ */ new Set();
  return value.map((coin, index) => {
    const record = requireRecord(coin, `terminal.coinsOfInterest[${index}]`);
    requireExactKeys(record, TERMINAL_COIN_KEYS, `terminal.coinsOfInterest[${index}]`);
    const label = requireString(record.label, `terminal.coinsOfInterest[${index}].label`);
    const id = requireString(record.id, `terminal.coinsOfInterest[${index}].id`);
    if (!label || !id) throw new Error(`Garbled save: invalid terminal coin ${index}`);
    const gameId = record.game_id === void 0 ? void 0 : requireString(record.game_id, `terminal.coinsOfInterest[${index}].game_id`);
    if (gameId === "") throw new Error(`Garbled save: invalid terminal coin game id ${index}`);
    const gameCoinKind = record.game_coin_kind;
    if (gameCoinKind !== void 0 && gameCoinKind !== "current" && gameCoinKind !== "reward") {
      throw new Error(`Garbled save: invalid terminal coin kind ${index}`);
    }
    if (coinIds.has(id)) throw new Error(`Garbled save: duplicate terminal coin ${id}`);
    coinIds.add(id);
    return {
      label,
      id,
      ...gameId === void 0 ? {} : { game_id: gameId },
      ...gameCoinKind === void 0 ? {} : { game_coin_kind: gameCoinKind }
    };
  });
}

// src/util/jsonSafe.ts
function jsonParse(text) {
  return JSON.parse(text, (_key, value) => {
    if (typeof value === "number" && Number.isInteger(value)) {
      return BigInt(value);
    }
    return value;
  });
}
function integersToBigInt(value) {
  return convertIntegersToBigInt(value);
}
function convertIntegersToBigInt(value) {
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (value === null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) return value.map(convertIntegersToBigInt);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = convertIntegersToBigInt(entry);
  }
  return out;
}
function uint8ToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
function jsonValue(v) {
  if (v === null || v === void 0) return "null";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (v instanceof Uint8Array) return JSON.stringify(uint8ToBase64(v));
  if (ArrayBuffer.isView(v)) {
    const view = v;
    return JSON.stringify(
      uint8ToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    );
  }
  if (Array.isArray(v)) return `[${v.map(jsonValue).join(",")}]`;
  const entries = Object.entries(v).filter(([, val]) => val !== void 0).map(([k, val]) => `${JSON.stringify(k)}:${jsonValue(val)}`);
  return `{${entries.join(",")}}`;
}
function jsonStringify(value) {
  return jsonValue(value);
}

// src/lib/session/fundingRequest.ts
var U32_MAX = 4294967295n;
var U64_MAX = 18446744073709551615n;
var CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9]\d*)$/;
var CANONICAL_COIN_ID = /^[0-9a-f]{64}$/;
function invalid(label, field) {
  throw new Error(`Invalid ${label}${field === void 0 ? "" : `.${field}`}`);
}
function canonicalU64(value, label, field) {
  if (typeof value !== "string" || !CANONICAL_UNSIGNED_DECIMAL.test(value) || BigInt(value) > U64_MAX) {
    invalid(label, field);
  }
  return value;
}
function canonicalOpcode(value, label, field, persisted) {
  if (persisted) {
    if (typeof value !== "bigint" || value < 0n || value > U32_MAX) invalid(label, field);
    return value;
  }
  if (typeof value === "bigint") {
    if (value < 0n || value > U32_MAX) invalid(label, field);
    return value;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > Number(U32_MAX)) {
    invalid(label, field);
  }
  return BigInt(value);
}
function canonicalMaxHeight(value, label, persisted) {
  if (typeof value === "string") return canonicalU64(value, label, "max_height");
  if (!persisted && (typeof value === "bigint" && value >= 0n && value <= U64_MAX || typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
    return value.toString();
  }
  invalid(label, "max_height");
}
function canonicalizeFundingRequest(value, label = "funding request", persisted = false) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(label);
  const request = value;
  if (persisted) {
    const allowed = /* @__PURE__ */ new Set(["amount", "fee", "conditions", "coin_id", "max_height"]);
    const unexpected = Object.keys(request).find((key) => !allowed.has(key));
    if (unexpected !== void 0) invalid(label, unexpected);
  }
  const amount = canonicalU64(request.amount, label, "amount");
  const fee = canonicalU64(request.fee, label, "fee");
  if (!Array.isArray(request.conditions)) invalid(label, "conditions");
  const conditions = request.conditions.map((value2, index) => {
    if (typeof value2 !== "object" || value2 === null || Array.isArray(value2)) {
      invalid(label, `conditions[${index}]`);
    }
    const condition = value2;
    if (persisted) {
      const unexpected = Object.keys(condition).find((key) => key !== "opcode" && key !== "args");
      if (unexpected !== void 0) invalid(label, `conditions[${index}].${unexpected}`);
    }
    if (!Array.isArray(condition.args) || !condition.args.every((arg) => typeof arg === "string")) {
      invalid(label, `conditions[${index}]`);
    }
    return Object.freeze({
      opcode: canonicalOpcode(condition.opcode, label, `conditions[${index}]`, persisted),
      args: Object.freeze([...condition.args])
    });
  });
  if (request.coin_id != null && (typeof request.coin_id !== "string" || !CANONICAL_COIN_ID.test(request.coin_id))) {
    invalid(label, "coin_id");
  }
  if (persisted && request.coin_id === null) invalid(label, "coin_id");
  if (persisted && request.max_height === null) invalid(label, "max_height");
  const maxHeight = request.max_height == null ? void 0 : canonicalMaxHeight(request.max_height, label, persisted);
  return Object.freeze({
    amount,
    fee,
    conditions: Object.freeze(conditions),
    ...request.coin_id == null ? {} : { coin_id: request.coin_id },
    ...maxHeight === void 0 ? {} : { max_height: maxHeight }
  });
}
function decodeCanonicalFundingRequest(value, label = "persisted funding request") {
  return canonicalizeFundingRequest(value, label, true);
}
function fundingRequestKey(request) {
  return `funding:${jsonStringify({
    amount: request.amount,
    fee: request.fee,
    conditions: request.conditions,
    ...request.coin_id === void 0 ? {} : { coin_id: request.coin_id },
    ...request.max_height === void 0 ? {} : { max_height: BigInt(request.max_height) }
  })}`;
}

// src/lib/session/providerValidation.ts
var MAX_PROVIDER_IDENTITY_LENGTH = 256;
function strictRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}
function exactFields(fields, expected, label) {
  const keys = Object.keys(fields);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(fields, key))) {
    throw new Error(`Garbled save: invalid ${label} fields`);
  }
}
function exactStageFields(fields, common, stages, label) {
  const extras = stages[String(fields.stage)];
  if (!extras) throw new Error(`Garbled save: invalid ${label}.stage`);
  const hasRisk = Object.hasOwn(fields, "orphanRisk");
  exactFields(fields, [...common, ...extras, ...hasRisk ? ["orphanRisk"] : []], label);
  if (!hasRisk) return {};
  if (fields.orphanRisk !== "pre-id-response-lost") {
    throw new Error(`Garbled save: invalid ${label}.orphanRisk`);
  }
  return { orphanRisk: fields.orphanRisk };
}
function boundedString(value, label, maximum = MAX_PROVIDER_IDENTITY_LENGTH, allowEmpty = false) {
  if (typeof value !== "string" || !allowEmpty && value.length === 0 || value.length > maximum) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}
function strictU64(value, label) {
  if (typeof value !== "bigint" || value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}
function decodeProviderScope(value, label) {
  const fields = strictRecord(value, label);
  if (fields.provider === "cloud" && Object.keys(fields).length === 2) {
    return {
      provider: "cloud",
      walletId: boundedString(fields.walletId, `${label}.walletId`)
    };
  }
  if ((fields.provider === "walletconnect" || fields.provider === "sage") && Object.keys(fields).length === 3) {
    return {
      provider: fields.provider,
      fingerprint: boundedString(fields.fingerprint, `${label}.fingerprint`),
      chainId: boundedString(fields.chainId, `${label}.chainId`)
    };
  }
  if (fields.provider === "simulator" && Object.keys(fields).length === 2) {
    return {
      provider: "simulator",
      identity: boundedString(fields.identity, `${label}.identity`)
    };
  }
  throw new Error(`Garbled save: invalid ${label} fields`);
}
function decodeProviderOwner(value, label) {
  const fields = strictRecord(value, label);
  exactFields(fields, ["installationPlayerId", "peerSessionId", "providerScope"], label);
  return {
    installationPlayerId: boundedString(
      fields.installationPlayerId,
      `${label}.installationPlayerId`
    ),
    peerSessionId: boundedString(fields.peerSessionId, `${label}.peerSessionId`),
    providerScope: decodeProviderScope(fields.providerScope, `${label}.providerScope`)
  };
}

// src/lib/session/channelFundingValidation.ts
var MAX_RESERVATION_ID = 256;
var MAX_OPERATION_ID = 1024;
function decodeRequest(value, label) {
  const fields = strictRecord(value, label);
  exactFields(fields, ["kind", "canonical"], label);
  if (fields.kind !== "funding") throw new Error(`Garbled save: invalid ${label}.kind`);
  return {
    kind: "funding",
    canonical: decodeCanonicalFundingRequest(fields.canonical, `${label}.canonical`)
  };
}
function decodeChannelFundingEntry(value, label = "channel funding entry") {
  const fields = strictRecord(value, label);
  const commonKeys = ["owner", "purpose", "stage", "reason"];
  const stageKeys = {
    creating: ["disposition", "recoveryId", "request"],
    "best-effort-uncertain": ["disposition", "request", "lastAttemptEpoch"],
    "awaiting-channel": ["providerReservationId", "request"],
    "cancel-required": ["providerReservationId"],
    "best-effort-cancellation-uncertain": ["providerReservationId", "lastAttemptEpoch"],
    cancelling: ["providerReservationId", "recoveryId"]
  };
  const orphanRisk = exactStageFields(fields, commonKeys, stageKeys, label);
  const purpose = strictRecord(fields.purpose, `${label}.purpose`);
  exactFields(purpose, ["kind", "operationId"], `${label}.purpose`);
  if (purpose.kind !== "funding") throw new Error(`Garbled save: invalid ${label}.purpose.kind`);
  const common = {
    owner: decodeProviderOwner(fields.owner, `${label}.owner`),
    purpose: {
      kind: "funding",
      operationId: boundedString(
        purpose.operationId,
        `${label}.purpose.operationId`,
        MAX_OPERATION_ID
      )
    },
    reason: boundedString(
      fields.reason,
      `${label}.reason`,
      MAX_CHANNEL_FUNDING_REASON_LENGTH,
      true
    ),
    ...orphanRisk
  };
  const reservation = () => boundedString(
    fields.providerReservationId,
    `${label}.providerReservationId`,
    MAX_RESERVATION_ID
  );
  const recovery = () => boundedString(fields.recoveryId, `${label}.recoveryId`, MAX_RESERVATION_ID);
  switch (fields.stage) {
    case "creating":
    case "best-effort-uncertain": {
      if (fields.disposition !== "active" && fields.disposition !== "cancel-on-create") {
        throw new Error(`Garbled save: invalid ${label}.disposition`);
      }
      const request = decodeRequest(fields.request, `${label}.request`);
      return fields.stage === "creating" ? {
        ...common,
        stage: fields.stage,
        disposition: fields.disposition,
        request,
        recoveryId: recovery()
      } : {
        ...common,
        stage: fields.stage,
        disposition: fields.disposition,
        request,
        lastAttemptEpoch: strictU64(fields.lastAttemptEpoch, `${label}.lastAttemptEpoch`)
      };
    }
    case "awaiting-channel":
      return {
        ...common,
        stage: fields.stage,
        providerReservationId: reservation(),
        request: decodeRequest(fields.request, `${label}.request`)
      };
    case "cancelling":
      return {
        ...common,
        stage: fields.stage,
        providerReservationId: reservation(),
        recoveryId: recovery()
      };
    case "best-effort-cancellation-uncertain":
      return {
        ...common,
        stage: fields.stage,
        providerReservationId: reservation(),
        lastAttemptEpoch: strictU64(fields.lastAttemptEpoch, `${label}.lastAttemptEpoch`)
      };
    default:
      return { ...common, stage: "cancel-required", providerReservationId: reservation() };
  }
}
function decodeChannelFundingEntries(value, label = "channel funding record", expectedPurpose) {
  if (!Array.isArray(value)) throw new Error(`Garbled save: invalid ${label}`);
  const entryKeys = /* @__PURE__ */ new Set();
  const operations = /* @__PURE__ */ new Map();
  return value.map((item, index) => {
    const entry = decodeChannelFundingEntry(item, `${label}[${index}]`);
    if (expectedPurpose && entry.purpose.kind !== expectedPurpose) {
      throw new Error(`Garbled save: invalid ${label}[${index}].purpose.kind`);
    }
    const entryKey = channelFundingEntryKey(entry);
    if (entryKeys.has(entryKey)) throw new Error(`Garbled save: duplicate ${label} entry`);
    entryKeys.add(entryKey);
    const operation = channelFundingKey(entry.owner, entry.purpose);
    const priorStages = operations.get(operation) ?? {
      preId: false,
      cancellation: false,
      awaiting: false
    };
    const preId = entry.stage === "creating" || entry.stage === "best-effort-uncertain";
    const cancellation = entry.stage === "cancel-required" || entry.stage === "cancelling" || entry.stage === "best-effort-cancellation-uncertain";
    const awaiting = entry.stage === "awaiting-channel";
    if (preId && (priorStages.preId || priorStages.awaiting) || awaiting && (priorStages.preId || priorStages.awaiting) || cancellation && priorStages.cancellation) {
      throw new Error(`Garbled save: contradictory ${label} operation`);
    }
    operations.set(operation, {
      preId: priorStages.preId || preId,
      cancellation: priorStages.cancellation || cancellation,
      awaiting: priorStages.awaiting || awaiting
    });
    return entry;
  });
}

// src/lib/session/feeAttachmentStore.ts
var MAX_FEE_ATTACHMENT_REASON_LENGTH = 256;
function isFeeAttachmentCancellation(entry) {
  return entry.stage === "cancel-required" || entry.stage === "best-effort-cancellation-uncertain" || entry.stage === "cancelling";
}
function isRetiringFeeAttachment(entry) {
  return isFeeAttachmentCancellation(entry) || (entry.stage === "creating" || entry.stage === "best-effort-uncertain") && entry.disposition === "cancel-on-create";
}
function feeAttachmentOperationKey(owner, submissionId) {
  const ownerKey = providerOwnerKey(owner);
  return `${ownerKey.length}:${ownerKey}${submissionId.length}:${submissionId}`;
}
function feeAttachmentEntryKey(entry) {
  if (entry.stage === "best-effort-uncertain" && entry.disposition === "cancel-on-create") {
    return `retired-uncertainty:${feeAttachmentOperationKey(entry.owner, entry.submissionId)}`;
  }
  if (entry.stage === "creating" && entry.disposition === "cancel-on-create") {
    return `recovery:${feeAttachmentOperationKey(entry.owner, entry.submissionId)}:${entry.recoveryId}`;
  }
  return entry.stage === "creating" || entry.stage === "best-effort-uncertain" ? `submission:${feeAttachmentOperationKey(entry.owner, entry.submissionId)}` : `reservation:${entry.providerReservationId}`;
}
function feeAttachmentForSubmission(entries, owner, submissionId) {
  const key = feeAttachmentOperationKey(owner, submissionId);
  const matching = entries.filter(
    (entry) => feeAttachmentOperationKey(entry.owner, entry.submissionId) === key
  );
  return matching.find((entry) => !isRetiringFeeAttachment(entry)) ?? matching[0] ?? null;
}
function activeFeeAttachmentForSubmission(entries, owner, submissionId) {
  return feeAttachmentForSubmission(
    entries.filter((entry) => !isRetiringFeeAttachment(entry)),
    owner,
    submissionId
  );
}
function identifiedFeeAttachment(entries, providerReservationId) {
  const entry = entries.find(
    (candidate) => candidate.stage !== "creating" && candidate.stage !== "best-effort-uncertain" && candidate.providerReservationId === providerReservationId
  );
  return entry && entry.stage !== "creating" && entry.stage !== "best-effort-uncertain" ? entry : null;
}

// src/lib/session/feeAttachmentValidation.ts
var MAX_ID = 1024;
function decodeRequest2(value, label) {
  const fields = strictRecord(value, label);
  exactFields(fields, ["kind", "uniqueId", "fee", "concurrentSpendCoinId"], label);
  if (fields.kind !== "fee" || typeof fields.concurrentSpendCoinId !== "string" || !/^[0-9a-f]{64}$/.test(fields.concurrentSpendCoinId)) {
    throw new Error(`Garbled save: invalid ${label} fields`);
  }
  return {
    kind: "fee",
    uniqueId: boundedString(fields.uniqueId, `${label}.uniqueId`, MAX_ID),
    fee: strictU64(fields.fee, `${label}.fee`),
    concurrentSpendCoinId: fields.concurrentSpendCoinId
  };
}
function decodeFeeAttachment(value, label) {
  const fields = strictRecord(value, label);
  const commonKeys = ["owner", "submissionId", "stage", "reason"];
  const stageKeys = {
    creating: ["disposition", "recoveryId", "request"],
    "best-effort-uncertain": ["disposition", "request", "lastAttemptEpoch"],
    reserved: ["providerReservationId"],
    "retained-for-replay": ["providerReservationId"],
    "cancel-required": ["providerReservationId"],
    "best-effort-cancellation-uncertain": ["providerReservationId", "lastAttemptEpoch"],
    cancelling: ["providerReservationId", "recoveryId"]
  };
  const orphanRisk = exactStageFields(fields, commonKeys, stageKeys, label);
  const common = {
    owner: decodeProviderOwner(fields.owner, `${label}.owner`),
    submissionId: boundedString(fields.submissionId, `${label}.submissionId`, MAX_ID),
    reason: boundedString(fields.reason, `${label}.reason`, MAX_FEE_ATTACHMENT_REASON_LENGTH, true),
    ...orphanRisk
  };
  const reservation = () => boundedString(fields.providerReservationId, `${label}.providerReservationId`, MAX_ID);
  if (fields.stage === "creating" || fields.stage === "best-effort-uncertain") {
    if (fields.disposition !== "active" && fields.disposition !== "cancel-on-create") {
      throw new Error(`Garbled save: invalid ${label}.disposition`);
    }
    const request = decodeRequest2(fields.request, `${label}.request`);
    return fields.stage === "creating" ? {
      ...common,
      stage: fields.stage,
      disposition: fields.disposition,
      request,
      recoveryId: boundedString(fields.recoveryId, `${label}.recoveryId`, MAX_ID)
    } : {
      ...common,
      stage: fields.stage,
      disposition: fields.disposition,
      request,
      lastAttemptEpoch: strictU64(fields.lastAttemptEpoch, `${label}.lastAttemptEpoch`)
    };
  }
  if (fields.stage === "cancelling") {
    return {
      ...common,
      stage: fields.stage,
      providerReservationId: reservation(),
      recoveryId: boundedString(fields.recoveryId, `${label}.recoveryId`, MAX_ID)
    };
  }
  if (fields.stage === "best-effort-cancellation-uncertain") {
    return {
      ...common,
      stage: fields.stage,
      providerReservationId: reservation(),
      lastAttemptEpoch: strictU64(fields.lastAttemptEpoch, `${label}.lastAttemptEpoch`)
    };
  }
  return {
    ...common,
    stage: fields.stage,
    providerReservationId: reservation()
  };
}
function decodeFeeAttachments(value, label = "feeAttachments") {
  if (!Array.isArray(value)) throw new Error(`Garbled save: invalid ${label}`);
  const entries = /* @__PURE__ */ new Set();
  const operations = /* @__PURE__ */ new Set();
  return value.map((item, index) => {
    const entry = decodeFeeAttachment(item, `${label}[${index}]`);
    const entryKey = feeAttachmentEntryKey(entry);
    const operation = JSON.stringify([
      entry.owner.installationPlayerId,
      entry.owner.peerSessionId,
      entry.submissionId
    ]);
    const active = !isRetiringFeeAttachment(entry);
    if (entries.has(entryKey) || active && operations.has(operation)) {
      throw new Error(`Garbled save: duplicate ${label} entry`);
    }
    entries.add(entryKey);
    if (active) operations.add(operation);
    return entry;
  });
}

// src/lib/session/sessionSnapshot.ts
function snapshotFromSessionModel(model, facts = {
  waitingStateEnteredAt: null,
  cleanShutdownGraceStartedAt: null
}) {
  const requireCatalogGameType = (gameType, label) => {
    if (!isCatalogGameType(gameType)) {
      throw new Error(`Session invariant broken: ${label} ${gameType} is not a catalog gameType`);
    }
    return gameType;
  };
  const persistedGameIds = Array.from(
    /* @__PURE__ */ new Set([
      ...model.game.activeIds,
      ...model.game.currentHandIds,
      ...model.game.lastDisplayedId === null ? [] : [model.game.lastDisplayedId]
    ])
  );
  for (const id of persistedGameIds) {
    if (!model.game.instances[id]) {
      throw new Error(`Session invariant broken: game ${id} is missing its keyed instance`);
    }
  }
  const hasPersistedHand = persistedGameIds.length > 0 || model.game.handState !== null;
  if (model.game.currentHandIds.length > 0 && model.game.currentHandOrigin === null) {
    throw new Error("Session invariant broken: current hand is missing its origin");
  }
  if (model.game.currentHandIds.length === 0 && model.game.currentHandOrigin !== null) {
    throw new Error("Session invariant broken: hand origin has no current hand");
  }
  const lastHandProposal = model.betweenHand.lastHandProposal;
  if (hasPersistedHand && lastHandProposal === null) {
    throw new Error(
      "Session invariant broken: persisted hand is missing betweenHandLastHandProposal"
    );
  }
  for (const proposal of [
    lastHandProposal,
    model.betweenHand.rejectedOnceHandProposal,
    model.betweenHand.pendingRetryHandProposal,
    ...model.betweenHand.pendingProposals.map(({ handProposal }) => handProposal)
  ]) {
    if (proposal !== null && !validateHandProposal(proposal)) {
      throw new Error(`Session invariant broken: invalid ${proposal.gameType} hand proposal`);
    }
  }
  const proposalIds = /* @__PURE__ */ new Set();
  let uncancelledProposals = 0;
  for (const proposal of model.betweenHand.pendingProposals) {
    if (proposalIds.has(proposal.id)) {
      throw new Error(`Session invariant broken: pending proposal ${proposal.id} appears twice`);
    }
    proposalIds.add(proposal.id);
    if (isUncancelledProposal(proposal)) uncancelledProposals += 1;
  }
  if (uncancelledProposals > 1) {
    throw new Error("Session invariant broken: multiple uncancelled proposals");
  }
  if (model.game.handState !== null) {
    requireCatalogGameType(model.game.handState.gameType, "handState.gameType");
  }
  return {
    handKey: BigInt(model.game.handKey),
    activeGameIds: model.game.activeIds,
    activeGameType: requireCatalogGameType(model.game.activeGameType, "activeGameType"),
    handState: model.game.handState,
    currentHandGameIds: model.game.currentHandIds,
    currentHandOrigin: model.game.currentHandOrigin,
    lastDisplayedGameId: model.game.lastDisplayedId,
    gameInstances: Object.fromEntries(persistedGameIds.map((id) => [id, model.game.instances[id]])),
    channelStatus: facts.channelStatus === void 0 ? channelStatusPayloadFromModel(model.channel.status) : facts.channelStatus,
    cleanShutdownStarted: model.channel.cleanShutdownStarted,
    betweenHandMode: model.betweenHand.mode,
    betweenHandCompose: {
      selectedGame: model.betweenHand.compose.selectedGame,
      gameTimeout: model.betweenHand.compose.gameTimeout
    },
    betweenHandLastHandProposal: lastHandProposal,
    betweenHandRejectedOnceHandProposal: model.betweenHand.rejectedOnceHandProposal,
    betweenHandPendingRetryHandProposal: model.betweenHand.pendingRetryHandProposal,
    newHandRequested: model.betweenHand.newHandRequested,
    pendingProposals: model.betweenHand.pendingProposals,
    waitingStateEnteredAt: facts.waitingStateEnteredAt,
    cleanShutdownGraceStartedAt: facts.cleanShutdownGraceStartedAt
  };
}

// src/lib/session/persistence.ts
var AGGREGATE_FIELDS = /* @__PURE__ */ new Set([
  "schema",
  "version",
  "identity",
  "preferences",
  "history",
  "session",
  "walletContext",
  "channelFundingOperations",
  "feeAttachments",
  "rejectionTransports"
]);
var SESSION_FIELDS = {
  "pre-handshake": /* @__PURE__ */ new Set(["phase", "pairing", "transport"]),
  live: /* @__PURE__ */ new Set(["phase", "pairing", "live", "presentation"]),
  terminal: /* @__PURE__ */ new Set(["phase", "terminal", "presentation"])
};
var IDENTITY_FIELDS = /* @__PURE__ */ new Set(["playerId", "sessionId", "myHubPlayerId"]);
var PREFERENCE_FIELDS = /* @__PURE__ */ new Set([
  "alias",
  "theme",
  "defaultFee",
  "feeUnit",
  "hubUrl",
  "lastHubUrl",
  "activeTab",
  "unreadGame",
  "walletAlert",
  "hubAlert",
  "blockchainType",
  "network"
]);
var HISTORY_FIELDS = /* @__PURE__ */ new Set(["humanHistory", "wasmNotificationHistory", "diagnosticLog"]);
var PAIRING_FIELDS = /* @__PURE__ */ new Set([
  "token",
  "peerId",
  "gameSessionId",
  "iStarted",
  "myContribution",
  "theirContribution",
  "perGameAmount",
  "channelTimeout",
  "unrollTimeout",
  "myAlias",
  "opponentAlias"
]);
var TRANSPORT_FIELDS = /* @__PURE__ */ new Set([
  "messageNumber",
  "remoteNumber",
  "unackedMessages",
  "disposition",
  "terminalHandoff"
]);
var LIVE_FIELDS = /* @__PURE__ */ new Set([
  ...TRANSPORT_FIELDS,
  "serializedGameSession",
  "gameSessionSchemaVersion",
  "rewardPuzzleHash"
]);
var TERMINAL_HANDOFF_FIELDS = /* @__PURE__ */ new Set(["id", "message", "msgno", "sent", "acknowledged"]);
var UNACKED_MESSAGE_FIELDS = /* @__PURE__ */ new Set(["msgno", "msg"]);
var TERMINAL_FIELDS = /* @__PURE__ */ new Set(["iStarted", "coinsOfInterest", "myAlias", "opponentAlias"]);
var REJECTION_FIELDS = /* @__PURE__ */ new Set([
  "kind",
  "peerId",
  "sessionId",
  "messageNumber",
  "remoteNumber",
  "unackedMessages",
  "createdAt"
]);
var PRESENTATION_FIELDS = /* @__PURE__ */ new Set([
  "handKey",
  "activeGameIds",
  "currentHandGameIds",
  "currentHandOrigin",
  "lastDisplayedGameId",
  "gameInstances",
  "activeGameType",
  "handState",
  "channelStatus",
  "cleanShutdownStarted",
  "betweenHandMode",
  "betweenHandCompose",
  "betweenHandLastHandProposal",
  "betweenHandRejectedOnceHandProposal",
  "betweenHandPendingRetryHandProposal",
  "newHandRequested",
  "pendingProposals",
  "waitingStateEnteredAt",
  "cleanShutdownGraceStartedAt"
]);
var GAME_INSTANCE_FIELDS = /* @__PURE__ */ new Set(["id", "amount", "coinHex", "presentation", "terminal"]);
var GAME_TERMINAL_FIELDS = /* @__PURE__ */ new Set(["type", "outcome", "label", "myReward", "rewardCoinHex"]);
var GAME_TERMINAL_TYPES = /* @__PURE__ */ new Set([
  "none",
  "settled",
  "insufficient-balance",
  "ended-cancelled",
  "game-error"
]);
var GAME_PRESENTATIONS = /* @__PURE__ */ new Set([
  "off-chain-my-turn",
  "off-chain-their-turn",
  "on-chain-my-turn",
  "on-chain-their-turn",
  "playing-move",
  "replaying-move",
  "illegal-move",
  "submitting-timeout",
  "finishing",
  "finishing-waiting-timeout",
  "finishing-spending",
  "ended"
]);
function parseIdentity(value) {
  const fields = requireRecord(value, "identity");
  requireExactKeys(fields, IDENTITY_FIELDS, "identity");
  return {
    playerId: requireString(fields.playerId, "identity.playerId"),
    sessionId: optionalString(fields.sessionId, "identity.sessionId"),
    myHubPlayerId: optionalString(fields.myHubPlayerId, "identity.myHubPlayerId")
  };
}
function parsePreferences(value) {
  const fields = requireRecord(value, "preferences");
  requireExactKeys(fields, PREFERENCE_FIELDS, "preferences");
  const theme = fields.theme === void 0 ? void 0 : parseDiscriminant(
    fields.theme,
    /* @__PURE__ */ new Set(["dark", "light"]),
    "preferences.theme"
  );
  const feeUnit = fields.feeUnit === void 0 ? void 0 : parseDiscriminant(
    fields.feeUnit,
    /* @__PURE__ */ new Set(["mojo", "xch"]),
    "preferences.feeUnit"
  );
  const blockchainType = fields.blockchainType === void 0 ? void 0 : parseDiscriminant(
    fields.blockchainType,
    /* @__PURE__ */ new Set(["simulator", "walletconnect", "sage", "cloud"]),
    "preferences.blockchainType"
  );
  const network = fields.network === void 0 ? void 0 : parseDiscriminant(
    fields.network,
    /* @__PURE__ */ new Set(["mainnet", "testnet"]),
    "preferences.network"
  );
  return {
    alias: optionalString(fields.alias, "preferences.alias", true),
    theme,
    defaultFee: fields.defaultFee === void 0 ? void 0 : requireBigint(fields.defaultFee, "preferences.defaultFee"),
    feeUnit,
    hubUrl: optionalString(fields.hubUrl, "preferences.hubUrl"),
    lastHubUrl: optionalString(fields.lastHubUrl, "preferences.lastHubUrl"),
    activeTab: optionalString(fields.activeTab, "preferences.activeTab"),
    unreadGame: fields.unreadGame === void 0 ? void 0 : requireBoolean(fields.unreadGame, "preferences.unreadGame"),
    walletAlert: fields.walletAlert === void 0 ? void 0 : requireBoolean(fields.walletAlert, "preferences.walletAlert"),
    hubAlert: fields.hubAlert === void 0 ? void 0 : requireBoolean(fields.hubAlert, "preferences.hubAlert"),
    blockchainType,
    network
  };
}
function parseHistory(value) {
  const fields = requireRecord(value, "history");
  requireExactKeys(fields, HISTORY_FIELDS, "history");
  return {
    humanHistory: fields.humanHistory === void 0 ? void 0 : parseStringArray(fields.humanHistory, "history.humanHistory"),
    wasmNotificationHistory: fields.wasmNotificationHistory === void 0 ? void 0 : parseStringArray(fields.wasmNotificationHistory, "history.wasmNotificationHistory"),
    diagnosticLog: fields.diagnosticLog === void 0 ? void 0 : recentDiagnosticEntries(parseStringArray(fields.diagnosticLog, "history.diagnosticLog"))
  };
}
function parsePairing(value) {
  const fields = requireRecord(value, "pairing");
  requireExactKeys(fields, PAIRING_FIELDS, "pairing");
  const pairing = {
    token: requireString(fields.token, "pairing.token"),
    peerId: optionalString(fields.peerId, "pairing.peerId"),
    gameSessionId: requireString(fields.gameSessionId, "pairing.gameSessionId"),
    iStarted: requireBoolean(fields.iStarted, "pairing.iStarted"),
    myContribution: requireString(fields.myContribution, "pairing.myContribution"),
    theirContribution: requireString(fields.theirContribution, "pairing.theirContribution"),
    perGameAmount: requireString(fields.perGameAmount, "pairing.perGameAmount"),
    channelTimeout: optionalString(fields.channelTimeout, "pairing.channelTimeout"),
    unrollTimeout: optionalString(fields.unrollTimeout, "pairing.unrollTimeout"),
    myAlias: optionalString(fields.myAlias, "pairing.myAlias", true),
    opponentAlias: optionalString(fields.opponentAlias, "pairing.opponentAlias", true)
  };
  validatePairing(pairing);
  return pairing;
}
function parseTransportFields(fields, label) {
  if (!Array.isArray(fields.unackedMessages)) {
    throw new Error(`Garbled save: invalid ${label}.unackedMessages`);
  }
  if (!Object.hasOwn(fields, "terminalHandoff")) {
    throw new Error(`Garbled save: ${label}.terminalHandoff is required`);
  }
  const terminalHandoff = fields.terminalHandoff === null ? null : (() => {
    const record = requireRecord(fields.terminalHandoff, `${label}.terminalHandoff`);
    requireExactKeys(record, TERMINAL_HANDOFF_FIELDS, `${label}.terminalHandoff`);
    if (!(record.message instanceof Uint8Array)) {
      throw new Error(`Garbled save: invalid ${label}.terminalHandoff.message`);
    }
    return {
      id: requireString(record.id, `${label}.terminalHandoff.id`),
      message: record.message,
      msgno: requireBigint(record.msgno, `${label}.terminalHandoff.msgno`),
      sent: requireBoolean(record.sent, `${label}.terminalHandoff.sent`),
      acknowledged: requireBoolean(
        record.acknowledged,
        `${label}.terminalHandoff.acknowledged`
      )
    };
  })();
  return {
    messageNumber: requireBigint(fields.messageNumber, `${label}.messageNumber`),
    remoteNumber: requireBigint(fields.remoteNumber, `${label}.remoteNumber`),
    unackedMessages: fields.unackedMessages.map((message, index) => {
      const record = requireRecord(message, `${label}.unackedMessages[${index}]`);
      requireExactKeys(record, UNACKED_MESSAGE_FIELDS, `${label}.unackedMessages[${index}]`);
      if (!(record.msg instanceof Uint8Array)) {
        throw new Error(`Garbled save: invalid ${label}.unackedMessages[${index}].msg`);
      }
      return {
        msgno: requireBigint(record.msgno, `${label}.unackedMessages[${index}].msgno`),
        msg: record.msg
      };
    }),
    disposition: parseDiscriminant(
      fields.disposition,
      /* @__PURE__ */ new Set(["active", "proposal-received", "outbound-reject", "inbound-reject"]),
      `${label}.disposition`
    ),
    terminalHandoff
  };
}
function parseTransport(value) {
  const fields = requireRecord(value, "transport");
  requireExactKeys(fields, TRANSPORT_FIELDS, "transport");
  const transport = parseTransportFields(fields, "transport");
  validateTransport(transport, "transport");
  return transport;
}
function parseLive(value) {
  const fields = requireRecord(value, "live");
  requireExactKeys(fields, LIVE_FIELDS, "live");
  const live = {
    ...parseTransportFields(fields, "live"),
    serializedGameSession: fields.serializedGameSession instanceof Uint8Array ? fields.serializedGameSession : (() => {
      throw new Error("Garbled save: invalid live.serializedGameSession");
    })(),
    gameSessionSchemaVersion: requireBigint(
      fields.gameSessionSchemaVersion,
      "live.gameSessionSchemaVersion"
    ),
    rewardPuzzleHash: requireString(fields.rewardPuzzleHash, "live.rewardPuzzleHash")
  };
  validateLive(live);
  return live;
}
function parseRejectionTransports(value) {
  if (!Array.isArray(value) || value.length > MAX_DURABLE_REJECTION_TRANSPORTS) {
    throw new Error("Garbled application state: invalid rejectionTransports");
  }
  const identities = /* @__PURE__ */ new Set();
  return value.map((entry, index) => {
    const label = `rejectionTransports[${index}]`;
    const fields = requireRecord(entry, label);
    requireExactKeys(fields, REJECTION_FIELDS, label);
    const peerId = requireString(fields.peerId, `${label}.peerId`);
    const sessionId = requireString(fields.sessionId, `${label}.sessionId`);
    if (!/^[0-9a-f]{32}$/.test(sessionId)) {
      throw new Error(`Garbled application state: invalid ${label}.sessionId`);
    }
    const identity = JSON.stringify([peerId, sessionId]);
    if (identities.has(identity)) {
      throw new Error(`Garbled application state: duplicate ${label}`);
    }
    identities.add(identity);
    if (!Array.isArray(fields.unackedMessages)) {
      throw new Error(`Garbled application state: invalid ${label}.unackedMessages`);
    }
    const createdAt = fields.createdAt;
    if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new Error(`Garbled application state: invalid ${label}.createdAt`);
    }
    return {
      kind: parseDiscriminant(
        fields.kind,
        /* @__PURE__ */ new Set(["outbound-reject", "inbound-receipt"]),
        `${label}.kind`
      ),
      peerId,
      sessionId,
      messageNumber: requireBigint(fields.messageNumber, `${label}.messageNumber`),
      remoteNumber: requireBigint(fields.remoteNumber, `${label}.remoteNumber`),
      unackedMessages: fields.unackedMessages.map((message, messageIndex) => {
        const messageLabel = `${label}.unackedMessages[${messageIndex}]`;
        const messageFields = requireRecord(message, messageLabel);
        requireExactKeys(messageFields, UNACKED_MESSAGE_FIELDS, messageLabel);
        if (!(messageFields.msg instanceof Uint8Array)) {
          throw new Error(`Garbled application state: invalid ${messageLabel}.msg`);
        }
        return {
          msgno: requireBigint(messageFields.msgno, `${messageLabel}.msgno`),
          msg: messageFields.msg
        };
      }),
      createdAt
    };
  });
}
function parseGameTerminal(value, label) {
  const fields = requireRecord(value, label);
  requireExactKeys(fields, GAME_TERMINAL_FIELDS, label);
  const type = parseDiscriminant(
    fields.type,
    GAME_TERMINAL_TYPES,
    `${label}.type`
  );
  let outcome = null;
  if (type === "settled") {
    if (!isSettlementOutcome(fields.outcome)) {
      throw new Error(`Garbled save: invalid ${label}.outcome: ${String(fields.outcome)}`);
    }
    outcome = fields.outcome;
  } else if (requireNullableString(fields.outcome, `${label}.outcome`, true) !== null) {
    throw new Error(`Garbled save: unexpected ${label}.outcome for ${type}`);
  }
  return {
    type,
    outcome,
    label: requireNullableString(fields.label, `${label}.label`, true),
    myReward: requireNullableString(fields.myReward, `${label}.myReward`, true),
    rewardCoinHex: requireNullableString(fields.rewardCoinHex, `${label}.rewardCoinHex`, true)
  };
}
function parseGameInstance(key, value) {
  const label = `gameInstances.${key}`;
  const fields = requireRecord(value, label);
  requireExactKeys(fields, GAME_INSTANCE_FIELDS, label);
  if (fields.id !== key) {
    throw new Error(`Garbled save: game instance ${key} has mismatched id ${String(fields.id)}`);
  }
  const amount = requireString(fields.amount, `${label}.amount`);
  parseDecimalString(amount, `${label}.amount`, 0n);
  return {
    id: key,
    amount,
    coinHex: requireNullableString(fields.coinHex, `${label}.coinHex`),
    presentation: parseDiscriminant(
      fields.presentation,
      GAME_PRESENTATIONS,
      `${label}.presentation`
    ),
    terminal: parseGameTerminal(fields.terminal, `${label}.terminal`)
  };
}
function parsePresentation(value) {
  const fields = requireRecord(value, "presentation");
  requireExactKeys(fields, PRESENTATION_FIELDS, "presentation");
  if (typeof fields.handKey !== "bigint" || fields.handKey < 0n || fields.handKey > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Garbled save: invalid handKey");
  }
  const activeGameIds = requireUniqueIds(fields.activeGameIds, "activeGameIds");
  const currentHandGameIds = requireUniqueIds(fields.currentHandGameIds, "currentHandGameIds");
  const currentHandOrigin = fields.currentHandOrigin === null ? null : parseDiscriminant(
    fields.currentHandOrigin,
    /* @__PURE__ */ new Set(["local", "peer"]),
    "currentHandOrigin"
  );
  const lastDisplayedGameId = requireNullableString(
    fields.lastDisplayedGameId,
    "lastDisplayedGameId"
  );
  const savedInstances = requireRecord(fields.gameInstances, "gameInstances");
  const gameInstances = Object.fromEntries(
    Object.entries(savedInstances).map(([id, instance]) => [id, parseGameInstance(id, instance)])
  );
  if (!isCatalogGameType(fields.activeGameType)) {
    throw new Error(`Garbled save: invalid activeGameType ${String(fields.activeGameType)}`);
  }
  const decodedHandState = fields.handState === null ? null : decodePersistedGameState(fields.handState);
  if (fields.handState !== null && decodedHandState === null) {
    throw new Error("Garbled save: invalid handState");
  }
  const compose = parseComposeDraftState(fields.betweenHandCompose);
  const lastHandProposal = fields.betweenHandLastHandProposal === null ? null : parseHandProposalSnapshot(
    fields.betweenHandLastHandProposal,
    "betweenHandLastHandProposal"
  );
  const rejectedOnceHandProposal = fields.betweenHandRejectedOnceHandProposal === null ? null : parseHandProposalSnapshot(
    fields.betweenHandRejectedOnceHandProposal,
    "betweenHandRejectedOnceHandProposal"
  );
  const pendingRetryHandProposal = fields.betweenHandPendingRetryHandProposal === null ? null : parseHandProposalSnapshot(
    fields.betweenHandPendingRetryHandProposal,
    "betweenHandPendingRetryHandProposal"
  );
  const pendingProposals = parsePendingProposals(fields.pendingProposals, "pendingProposals");
  const waitingStateEnteredAt = fields.waitingStateEnteredAt === null ? null : requireBigint(fields.waitingStateEnteredAt, "waitingStateEnteredAt");
  const cleanShutdownGraceStartedAt = fields.cleanShutdownGraceStartedAt === null ? null : requireBigint(fields.cleanShutdownGraceStartedAt, "cleanShutdownGraceStartedAt");
  return {
    handKey: fields.handKey,
    activeGameIds,
    currentHandGameIds,
    currentHandOrigin,
    lastDisplayedGameId,
    gameInstances,
    activeGameType: fields.activeGameType,
    handState: decodedHandState,
    channelStatus: validateChannelStatus(fields.channelStatus),
    cleanShutdownStarted: requireBoolean(fields.cleanShutdownStarted, "cleanShutdownStarted"),
    betweenHandMode: parseDiscriminant(
      fields.betweenHandMode,
      BETWEEN_HAND_MODES,
      "betweenHandMode"
    ),
    betweenHandCompose: {
      selectedGame: compose.selectedGame,
      gameTimeout: compose.gameTimeout
    },
    betweenHandLastHandProposal: lastHandProposal,
    betweenHandRejectedOnceHandProposal: rejectedOnceHandProposal,
    betweenHandPendingRetryHandProposal: pendingRetryHandProposal,
    newHandRequested: requireBoolean(fields.newHandRequested, "newHandRequested"),
    pendingProposals,
    waitingStateEnteredAt,
    cleanShutdownGraceStartedAt
  };
}
function validatePresentationInvariants(save, phase) {
  if (phase === "terminal" && !isTerminalChannelSnapshot(save.channelStatus)) {
    throw new Error("Garbled save: terminal phase requires a terminal channelStatus");
  }
  const activeIds = save.activeGameIds;
  const currentHandIds = save.currentHandGameIds;
  const currentSet = new Set(currentHandIds);
  for (const id of activeIds) {
    if (!currentSet.has(id)) {
      throw new Error(`Garbled save: active game ${id} is not in currentHandGameIds`);
    }
  }
  const referencedIds = /* @__PURE__ */ new Set([
    ...activeIds,
    ...currentHandIds,
    ...save.lastDisplayedGameId === null ? [] : [save.lastDisplayedGameId]
  ]);
  for (const id of referencedIds) {
    if (!save.gameInstances[id]) {
      throw new Error(`Garbled save: game ${id} is missing its keyed instance`);
    }
  }
  for (const [id, instance] of Object.entries(save.gameInstances)) {
    if (!referencedIds.has(id)) {
      throw new Error(`Garbled save: game ${id} is an unrelated keyed instance`);
    }
    validateTerminalFields(instance.terminal, `gameInstances.${id}.terminal`);
    const terminal = instance.terminal.type !== "none";
    if (instance.presentation === "ended" !== terminal) {
      throw new Error(`Garbled save: gameInstances.${id} presentation and terminal state disagree`);
    }
    if (activeIds.includes(id) && terminal) {
      throw new Error(`Garbled save: active game ${id} is terminal`);
    }
  }
  const hasCurrentHand = activeIds.length > 0 || currentHandIds.length > 0;
  if (hasCurrentHand !== (save.currentHandOrigin !== null)) {
    throw new Error(
      hasCurrentHand ? "Garbled save: current hand is missing currentHandOrigin" : "Garbled save: currentHandOrigin requires a current hand"
    );
  }
  if (currentHandIds.length > 0 && save.handState === null) {
    throw new Error("Garbled save: current hand is missing handState");
  }
  if (save.handState !== null) {
    if (currentHandIds.length === 0) {
      throw new Error("Garbled save: handState requires currentHandGameIds");
    }
    if (save.handState.gameType !== save.activeGameType) {
      throw new Error("Garbled save: activeGameType does not match handState.gameType");
    }
    try {
      restoreRegisteredGameHandState(save.activeGameType, save.handState);
    } catch (error) {
      throw new Error(
        `Garbled save: ${save.activeGameType} handState cannot be restored: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
  const hasPersistedHand = hasCurrentHand || save.handState !== null;
  if (hasPersistedHand && save.betweenHandLastHandProposal === null) {
    throw new Error("Garbled save: persisted hand is missing betweenHandLastHandProposal");
  }
  if (hasPersistedHand && save.betweenHandLastHandProposal !== null && save.betweenHandLastHandProposal.gameType !== save.activeGameType) {
    throw new Error(
      "Garbled save: activeGameType does not match betweenHandLastHandProposal.gameType"
    );
  }
}
function decodeDurableApplicationState(value) {
  const envelope = requireRecord(value, "application state");
  requireExactKeys(envelope, AGGREGATE_FIELDS, "application state");
  if (envelope.schema !== DURABLE_APPLICATION_STATE_SCHEMA) {
    throw new Error(`Garbled application state: unsupported schema ${String(envelope.schema)}`);
  }
  if (envelope.version !== DURABLE_APPLICATION_STATE_VERSION) {
    throw new Error(`Garbled application state: unsupported version ${String(envelope.version)}`);
  }
  const identity = parseIdentity(envelope.identity);
  const preferences = parsePreferences(envelope.preferences);
  const history = parseHistory(envelope.history);
  const walletContext = envelope.walletContext === null ? null : decodeProviderScope(envelope.walletContext, "walletContext");
  const channelFundingOperations = decodeChannelFundingEntries(
    envelope.channelFundingOperations,
    "channelFundingOperations",
    "funding"
  );
  const feeAttachments = decodeFeeAttachments(envelope.feeAttachments);
  const providerReservationIds = /* @__PURE__ */ new Set();
  for (const entry of [...channelFundingOperations, ...feeAttachments]) {
    if (entry.stage === "creating" || entry.stage === "best-effort-uncertain") continue;
    if (providerReservationIds.has(entry.providerReservationId)) {
      throw new Error(
        `Garbled application state: duplicate provider reservation ${entry.providerReservationId}`
      );
    }
    providerReservationIds.add(entry.providerReservationId);
  }
  if ((channelFundingOperations.length > 0 || feeAttachments.length > 0) && walletContext === null) {
    throw new Error("Garbled application state: provider-backed operations require walletContext");
  }
  const rejectionTransports = parseRejectionTransports(envelope.rejectionTransports);
  const common = {
    schema: DURABLE_APPLICATION_STATE_SCHEMA,
    version: DURABLE_APPLICATION_STATE_VERSION,
    identity,
    preferences,
    history,
    walletContext,
    channelFundingOperations,
    feeAttachments,
    rejectionTransports
  };
  let session;
  const sessionEnvelope = envelope.session === null ? null : requireRecord(envelope.session, "session");
  let presentation = null;
  let restoring = false;
  switch (sessionEnvelope?.phase) {
    case void 0:
      session = null;
      break;
    case "pre-handshake":
      requireExactKeys(sessionEnvelope, SESSION_FIELDS["pre-handshake"], "session");
      session = {
        phase: "pre-handshake",
        pairing: parsePairing(sessionEnvelope.pairing),
        transport: parseTransport(sessionEnvelope.transport)
      };
      break;
    case "live":
      requireExactKeys(sessionEnvelope, SESSION_FIELDS.live, "session");
      presentation = parsePresentation(sessionEnvelope.presentation);
      session = {
        phase: "live",
        pairing: parsePairing(sessionEnvelope.pairing),
        live: parseLive(sessionEnvelope.live),
        presentation
      };
      restoring = true;
      break;
    case "terminal": {
      requireExactKeys(sessionEnvelope, SESSION_FIELDS.terminal, "session");
      const terminal = requireRecord(sessionEnvelope.terminal, "terminal");
      requireExactKeys(terminal, TERMINAL_FIELDS, "terminal");
      presentation = parsePresentation(sessionEnvelope.presentation);
      session = {
        phase: "terminal",
        terminal: {
          iStarted: requireBoolean(terminal.iStarted, "terminal.iStarted"),
          coinsOfInterest: decodeTerminalCoins(terminal.coinsOfInterest),
          myAlias: requireNullableString(terminal.myAlias, "terminal.myAlias", true),
          opponentAlias: requireNullableString(
            terminal.opponentAlias,
            "terminal.opponentAlias",
            true
          )
        },
        presentation
      };
      break;
    }
    default:
      throw new Error(
        `Garbled application state: invalid session phase ${String(sessionEnvelope?.phase)}`
      );
  }
  if (session !== null && walletContext === null) {
    throw new Error("Garbled application state: durable session requires walletContext");
  }
  const typedEnvelope = { ...common, session };
  if (presentation === null) {
    return {
      save: typedEnvelope,
      model: createSessionModel({
        history: {
          humanHistory: recentEntries(history.humanHistory ?? [], HUMAN_HISTORY_LIMIT),
          wasmNotificationHistory: recentEntries(
            history.wasmNotificationHistory ?? [],
            WASM_NOTIFICATION_HISTORY_LIMIT
          ),
          diagnosticLog: recentDiagnosticEntries(history.diagnosticLog ?? [])
        }
      })
    };
  }
  if (typedEnvelope.session?.phase !== "live" && typedEnvelope.session?.phase !== "terminal") {
    throw new Error("Garbled save: presentation requires a live or terminal session");
  }
  validatePresentationInvariants(presentation, typedEnvelope.session.phase);
  const save = presentation;
  const activeIds = save.activeGameIds;
  const currentHandIds = save.currentHandGameIds;
  const instances = save.gameInstances;
  const handState = save.handState;
  const pendingProposals = save.pendingProposals;
  const restoredActiveIds = [...activeIds];
  const lastDisplayedId = save.lastDisplayedGameId;
  const mode = save.betweenHandMode;
  const model = normalizeSessionPresentation(
    createSessionModel({
      restore: {
        restoring,
        status: restoring ? "restoring" : "idle",
        error: null
      },
      channel: {
        status: save.channelStatus ? channelStatusModelFromPayload(save.channelStatus) : INITIAL_CHANNEL_STATUS_MODEL,
        connection: save.channelStatus ? { stateIdentifier: "running", stateDetail: [] } : { stateIdentifier: "starting", stateDetail: ["before handshake"] },
        cleanShutdownStarted: save.cleanShutdownStarted,
        dismissedChannelStatus: null,
        queue: []
      },
      game: {
        handKey: Number(save.handKey),
        activeIds: restoredActiveIds,
        currentHandIds,
        currentHandOrigin: save.currentHandOrigin,
        instances,
        lastDisplayedId,
        activeGameType: save.activeGameType,
        handState,
        queue: []
      },
      betweenHand: {
        mode,
        pendingProposals,
        rejectedOnceHandProposal: save.betweenHandRejectedOnceHandProposal,
        pendingRetryHandProposal: save.betweenHandPendingRetryHandProposal,
        lastHandProposal: save.betweenHandLastHandProposal,
        compose: {
          ...save.betweenHandCompose,
          proposalSent: pendingProposals.some(
            ({ lifecycle }) => lifecycle === "local-outgoing" || lifecycle === "local-cancel-queued"
          )
        },
        newHandRequested: save.newHandRequested
      },
      history: {
        humanHistory: recentEntries(typedEnvelope.history.humanHistory ?? [], HUMAN_HISTORY_LIMIT),
        wasmNotificationHistory: recentEntries(
          typedEnvelope.history.wasmNotificationHistory ?? [],
          WASM_NOTIFICATION_HISTORY_LIMIT
        ),
        diagnosticLog: recentDiagnosticEntries(typedEnvelope.history.diagnosticLog ?? [])
      }
    })
  );
  return {
    model,
    save: typedEnvelope
  };
}
function rehydrateDurableApplicationState(value) {
  const decoded = decodeDurableApplicationState(value);
  return {
    state: structuredClone(decoded.save),
    model: structuredClone(decoded.model)
  };
}

// src/lib/session/indexedDb.ts
var import_chia_gaming_bencodex = __toESM(require_bencodex(), 1);
var SESSION_DB_NAME = "chia-gaming-session";
var SESSION_DB_VERSION = 5;
var APPLICATION_STATE_STORE_NAME = "application-state";
var APPLICATION_STATE_RECORD_KEY = "current";
var COORDINATION_STORE_NAME = "coordination";
var COORDINATION_RECORD_KEY = "authority";
var COORDINATION_SCHEMA = "chia-gaming-storage-authority";
var COORDINATION_VERSION = 1;
var afterNextAuthorityCheckForTests = null;
var OBFUSCATION_KEY = new Uint8Array([
  74,
  127,
  44,
  145,
  211,
  86,
  232,
  27,
  160,
  99,
  245,
  56,
  196,
  135,
  14,
  109
]);
var SALT_LEN = 16;
var ARRAY_BUFFER_TAG = "\0arrayBuffer";
var NUMBER_TAG = "\0number";
var InvalidApplicationStateError2 = class extends Error {
  constructor(cause) {
    super("Stored application state is malformed", { cause });
    this.name = "InvalidApplicationStateError";
  }
};
var StorageAuthorityLostError = class extends Error {
  code = "STORAGE_AUTHORITY_LOST";
  constructor() {
    super("Durable storage authority was lost to another owner or epoch");
    this.name = "StorageAuthorityLostError";
  }
};
var StorageAuthorityRequiredError = class extends Error {
  code = "STORAGE_AUTHORITY_REQUIRED";
  constructor() {
    super("Durable storage authority must be claimed before this mutation");
    this.name = "StorageAuthorityRequiredError";
  }
};
function rc4Keystream(key, length) {
  const state = new Uint8Array(256);
  for (let i2 = 0; i2 < state.length; i2++) state[i2] = i2;
  let j = 0;
  for (let i2 = 0; i2 < state.length; i2++) {
    j = j + state[i2] + key[i2 % key.length] & 255;
    [state[i2], state[j]] = [state[j], state[i2]];
  }
  const stream = new Uint8Array(length);
  let i = 0;
  j = 0;
  for (let offset = 0; offset < length; offset++) {
    i = i + 1 & 255;
    j = j + state[i] & 255;
    [state[i], state[j]] = [state[j], state[i]];
    stream[offset] = state[state[i] + state[j] & 255];
  }
  return stream;
}
function toBencodexValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "bigint" || typeof value === "string" || value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "number") {
    return { [NUMBER_TAG]: String(value) };
  }
  if (value instanceof ArrayBuffer) {
    return { [ARRAY_BUFFER_TAG]: new Uint8Array(value) };
  }
  if (Array.isArray(value)) {
    return value.map(toBencodexValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(
        ([key, entry]) => entry === void 0 ? [] : [[key, toBencodexValue(entry)]]
      )
    );
  }
  throw new Error(`Cannot encode session value of type ${typeof value}`);
}
function fromBencodexValue(value) {
  if (value instanceof Map) {
    if (value.size === 1 && value.has(NUMBER_TAG)) {
      const number = value.get(NUMBER_TAG);
      if (typeof number !== "string") {
        throw new Error("Session record has an invalid number tag");
      }
      return Number(number);
    }
    if (value.size === 1 && value.has(ARRAY_BUFFER_TAG)) {
      const bytes = value.get(ARRAY_BUFFER_TAG);
      if (!(bytes instanceof Uint8Array)) {
        throw new Error("Session record has an invalid ArrayBuffer tag");
      }
      return bytes.buffer;
    }
    return Object.fromEntries(
      [...value.entries()].map(([key, entry]) => {
        if (typeof key !== "string") {
          throw new Error("Session record contains a non-text key");
        }
        return [key, fromBencodexValue(entry)];
      })
    );
  }
  if (Array.isArray(value)) {
    return value.map(fromBencodexValue);
  }
  return value;
}
function obfuscateRecord(record) {
  const plaintext = (0, import_chia_gaming_bencodex.encode)(toBencodexValue(record));
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const key = new Uint8Array(SALT_LEN + OBFUSCATION_KEY.length);
  key.set(salt);
  key.set(OBFUSCATION_KEY, SALT_LEN);
  const stream = rc4Keystream(key, plaintext.length);
  const masked = new Uint8Array(SALT_LEN + plaintext.length);
  masked.set(salt);
  for (let i = 0; i < plaintext.length; i++) {
    masked[SALT_LEN + i] = plaintext[i] ^ stream[i];
  }
  return masked;
}
function deobfuscateRecord(masked) {
  if (masked.length < SALT_LEN) {
    throw new Error("Obfuscated session record is missing its salt");
  }
  const salt = masked.slice(0, SALT_LEN);
  const ciphertext = masked.slice(SALT_LEN);
  const key = new Uint8Array(SALT_LEN + OBFUSCATION_KEY.length);
  key.set(salt);
  key.set(OBFUSCATION_KEY, SALT_LEN);
  const stream = rc4Keystream(key, ciphertext.length);
  const plaintext = new Uint8Array(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i++) {
    plaintext[i] = ciphertext[i] ^ stream[i];
  }
  return fromBencodexValue((0, import_chia_gaming_bencodex.decode)(plaintext));
}
function decodeRawApplicationState(record) {
  if (record == null) return null;
  if (!(record instanceof Uint8Array)) {
    throw new InvalidApplicationStateError2(
      new Error("Application state is not an obfuscated binary envelope")
    );
  }
  try {
    const decoded = deobfuscateRecord(record);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || decoded instanceof Uint8Array) {
      throw new Error("Obfuscated application state did not decode to an object");
    }
    return decodeDurableApplicationState(decoded).save;
  } catch (error) {
    throw new InvalidApplicationStateError2(error);
  }
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SESSION_DB_NAME, SESSION_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(COORDINATION_STORE_NAME)) {
        db.createObjectStore(COORDINATION_STORE_NAME);
      }
      for (const obsolete of ["session", "wallet-reservations", "rejections"]) {
        if (db.objectStoreNames.contains(obsolete)) db.deleteObjectStore(obsolete);
      }
      if (!db.objectStoreNames.contains(APPLICATION_STATE_STORE_NAME)) {
        db.createObjectStore(APPLICATION_STATE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open session database"));
    request.onblocked = () => reject(new Error("Session database open was blocked"));
  });
}
function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Session transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Session transaction failed"));
  });
}
function initialCoordinationRecord() {
  return {
    schema: COORDINATION_SCHEMA,
    version: COORDINATION_VERSION,
    ownerTabId: "",
    writeEpoch: 0n,
    resetEpoch: 0n,
    resetStatus: "active"
  };
}
function decodeCoordinationRecord(value) {
  if (value === void 0) return initialCoordinationRecord();
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 6) {
    throw new Error("Stored coordination authority is malformed");
  }
  const record = value;
  if (record.schema !== COORDINATION_SCHEMA || record.version !== COORDINATION_VERSION || typeof record.ownerTabId !== "string" || typeof record.writeEpoch !== "bigint" || record.writeEpoch < 0n || typeof record.resetEpoch !== "bigint" || record.resetEpoch < 0n || record.resetStatus !== "active" && record.resetStatus !== "pending") {
    throw new Error("Stored coordination authority is malformed");
  }
  return record;
}
function requestResult(request, failure) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(failure));
  });
}
async function readCoordinationRecord(transaction) {
  return decodeCoordinationRecord(
    await requestResult(
      transaction.objectStore(COORDINATION_STORE_NAME).get(COORDINATION_RECORD_KEY),
      "Failed to read storage coordination authority"
    )
  );
}
function putCoordinationRecord(transaction, record) {
  transaction.objectStore(COORDINATION_STORE_NAME).put(record, COORDINATION_RECORD_KEY);
}
function authorityMatches(record, authority, resetStatus = "active") {
  return record.ownerTabId === authority.ownerTabId && record.writeEpoch === authority.writeEpoch && record.resetEpoch === authority.resetEpoch && record.resetStatus === resetStatus;
}
async function openValidatedMutation(db, stores, authority) {
  const names = typeof stores === "string" ? [stores] : stores;
  const transaction = db.transaction(
    [.../* @__PURE__ */ new Set([...names, COORDINATION_STORE_NAME])],
    "readwrite"
  );
  const record = await readCoordinationRecord(transaction);
  if (!authorityMatches(record, authority)) {
    transaction.abort();
    try {
      await transactionComplete(transaction);
    } catch {
    }
    throw new StorageAuthorityLostError();
  }
  const afterAuthorityCheck = afterNextAuthorityCheckForTests;
  afterNextAuthorityCheckForTests = null;
  afterAuthorityCheck?.();
  return transaction;
}
async function claimAndReadDurableStorageRaw(ownerTabId) {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is unavailable; durable storage authority cannot be claimed");
  }
  const db = await openDatabase();
  try {
    const transaction = db.transaction(
      [COORDINATION_STORE_NAME, APPLICATION_STATE_STORE_NAME],
      "readwrite"
    );
    const current = await readCoordinationRecord(transaction);
    if (current.resetStatus === "pending") {
      transaction.abort();
      throw new Error("A durable hard reset is pending");
    }
    const claimed = {
      ...current,
      ownerTabId,
      writeEpoch: current.writeEpoch + 1n,
      resetStatus: "active"
    };
    const applicationStateRaw = await requestResult(
      transaction.objectStore(APPLICATION_STATE_STORE_NAME).get(APPLICATION_STATE_RECORD_KEY),
      "Failed to read application state while claiming storage authority"
    );
    putCoordinationRecord(transaction, claimed);
    await transactionComplete(transaction);
    const authority = {
      ownerTabId,
      writeEpoch: claimed.writeEpoch,
      resetEpoch: claimed.resetEpoch
    };
    let applicationState = null;
    let applicationStateError;
    try {
      applicationState = decodeRawApplicationState(applicationStateRaw);
    } catch (error) {
      if (!(error instanceof InvalidApplicationStateError2)) throw error;
      applicationStateError = error;
    }
    return {
      authority,
      applicationState,
      ...applicationStateError ? { applicationStateError } : {}
    };
  } finally {
    db.close();
  }
}
async function beginDurableHardResetRaw(ownerTabId) {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is unavailable; hard reset cannot be durably fenced");
  }
  const db = await openDatabase();
  try {
    const transaction = db.transaction(COORDINATION_STORE_NAME, "readwrite");
    const current = await readCoordinationRecord(transaction);
    const reset = {
      ...current,
      ownerTabId,
      writeEpoch: current.writeEpoch + 1n,
      resetEpoch: current.resetEpoch + 1n,
      resetStatus: "pending"
    };
    putCoordinationRecord(transaction, reset);
    await transactionComplete(transaction);
    return {
      ownerTabId,
      writeEpoch: reset.writeEpoch,
      resetEpoch: reset.resetEpoch
    };
  } finally {
    db.close();
  }
}
async function validatePendingHardResetAuthority(authority) {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(COORDINATION_STORE_NAME, "readonly");
    const record = await readCoordinationRecord(transaction);
    await transactionComplete(transaction);
    if (!authorityMatches(record, authority, "pending")) {
      throw new StorageAuthorityLostError();
    }
  } finally {
    db.close();
  }
}
async function readApplicationState() {
  if (typeof indexedDB === "undefined") return null;
  const db = await openDatabase();
  try {
    const transaction = db.transaction(APPLICATION_STATE_STORE_NAME, "readonly");
    const request = transaction.objectStore(APPLICATION_STATE_STORE_NAME).get(APPLICATION_STATE_RECORD_KEY);
    const record = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Failed to read application state"));
    });
    await transactionComplete(transaction);
    return decodeRawApplicationState(record);
  } finally {
    db.close();
  }
}
async function inspectApplicationState() {
  try {
    return { applicationState: await readApplicationState() };
  } catch (error) {
    if (!(error instanceof InvalidApplicationStateError2)) throw error;
    return { applicationState: null, applicationStateError: error };
  }
}
async function writeApplicationStateRaw(record, authority) {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is unavailable; application state remains dirty");
  }
  const snapshot = decodeDurableApplicationState(structuredClone(record)).save;
  const db = await openDatabase();
  try {
    const transaction = await openValidatedMutation(db, APPLICATION_STATE_STORE_NAME, authority);
    transaction.objectStore(APPLICATION_STATE_STORE_NAME).put(obfuscateRecord(snapshot), APPLICATION_STATE_RECORD_KEY);
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
}
var indexedDbStoragePort = {
  claimAndRead: claimAndReadDurableStorageRaw,
  beginHardReset: beginDurableHardResetRaw,
  validatePendingHardReset: validatePendingHardResetAuthority,
  writeApplicationState: writeApplicationStateRaw
};

// src/lib/session/saveHardReset.ts
var KNOWN_INDEXED_DB_NAMES = [
  SESSION_DB_NAME,
  "WALLET_CONNECT_V2_INDEXED_DB",
  "walletconnect",
  "walletconnect-v2"
];
function reloadAfterSuccessfulHardReset(result, reload) {
  if (!result.success) return false;
  reload();
  return true;
}
var DELETE_SETTLE_TIMEOUT_MS = 3e3;
function deleteIndexedDb(name, context = "IndexedDB cleanup") {
  return new Promise((settle) => {
    let timeout;
    const resolve = (failure) => {
      clearTimeout(timeout);
      settle(failure);
    };
    try {
      const request = indexedDB.deleteDatabase(name);
      timeout = setTimeout(() => {
        console.warn(
          `[save] ${context}: no response deleting IndexedDB database "${name}"; treating it as blocked`
        );
        resolve({ database: name, reason: "blocked" });
      }, DELETE_SETTLE_TIMEOUT_MS);
      request.onsuccess = () => resolve(null);
      request.onerror = () => {
        console.error(
          `[save] ${context}: failed to delete IndexedDB database "${name}":`,
          request.error
        );
        resolve({
          database: name,
          reason: "error",
          detail: request.error instanceof Error ? request.error.message : String(request.error)
        });
      };
      request.onblocked = () => {
        console.warn(
          `[save] ${context}: deletion blocked for IndexedDB database "${name}"; open connections will be wiped at next boot`
        );
        resolve({ database: name, reason: "blocked" });
      };
    } catch (error) {
      console.error(
        `[save] ${context}: failed to start IndexedDB database deletion for "${name}":`,
        error
      );
      resolve({
        database: name,
        reason: "error",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
function clearStorage(name, storage) {
  try {
    storage.clear();
    return null;
  } catch (error) {
    console.error(`[save] failed to clear ${name} during hard reset:`, error);
    return {
      database: name,
      reason: "error",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}
function clearBrowserStorageForHardReset() {
  return [
    clearStorage("localStorage", localStorage),
    clearStorage("sessionStorage", sessionStorage)
  ].filter((failure) => failure !== null);
}
var PENDING_WIPE_KEY = "appState_pendingWipe";
function markPendingWipe() {
  try {
    localStorage.setItem(PENDING_WIPE_KEY, "1");
  } catch {
    try {
      sessionStorage.setItem(PENDING_WIPE_KEY, "1");
    } catch {
    }
  }
}
function hasPendingWipe() {
  let localPending = false;
  try {
    localPending = localStorage.getItem(PENDING_WIPE_KEY) !== null;
  } catch {
  }
  let sessionPending = false;
  try {
    sessionPending = sessionStorage.getItem(PENDING_WIPE_KEY) !== null;
  } catch {
  }
  return localPending || sessionPending;
}
function clearPendingWipe() {
  const failures = [];
  try {
    localStorage.removeItem(PENDING_WIPE_KEY);
  } catch (error) {
    failures.push({
      database: "localStorage",
      reason: "error",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
  try {
    sessionStorage.removeItem(PENDING_WIPE_KEY);
  } catch (error) {
    failures.push({
      database: "sessionStorage",
      reason: "error",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
  return failures;
}
var pendingWipe = null;
function startPendingWalletConnectWipe() {
  if (pendingWipe) return pendingWipe;
  if (!hasPendingWipe()) return Promise.resolve({ success: true });
  pendingWipe = wipeAllStorageForHardReset();
  return pendingWipe;
}
function _resetPendingWalletConnectWipeForTests() {
  pendingWipe = null;
}
async function clearAllIndexedDbForHardReset() {
  if (typeof indexedDB === "undefined") return { success: true };
  let names;
  try {
    const factory = indexedDB;
    names = typeof factory.databases === "function" ? (await factory.databases()).map(({ name }) => name).filter((name) => typeof name === "string") : [...KNOWN_INDEXED_DB_NAMES];
  } catch (error) {
    return {
      success: false,
      failures: [
        {
          database: "indexedDB",
          reason: "error",
          detail: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }
  const failures = (await Promise.all([...new Set(names)].map((name) => deleteIndexedDb(name, "hard reset")))).filter((failure) => failure !== null);
  return failures.length === 0 ? { success: true } : { success: false, failures };
}
async function wipeAllStorageForHardReset() {
  const browserFailures = clearBrowserStorageForHardReset();
  markPendingWipe();
  const databaseResult = await clearAllIndexedDbForHardReset();
  const failures = [...browserFailures, ...databaseResult.success ? [] : databaseResult.failures];
  if (failures.length === 0) failures.push(...clearPendingWipe());
  const result = failures.length === 0 ? { success: true } : { success: false, failures };
  if (!result.success) markPendingWipe();
  return result;
}
function hardResetUnclaimedStorage() {
  signalHardResetToOtherTabs();
  return wipeAllStorageForHardReset();
}
function hardResetStorage(authority, runValidatedReset) {
  signalHardResetToOtherTabs();
  let result = { success: false, failures: [] };
  return runValidatedReset(authority, async () => {
    result = await wipeAllStorageForHardReset();
  }).then(() => result);
}

export {
  HUMAN_HISTORY_LIMIT,
  WASM_NOTIFICATION_HISTORY_LIMIT,
  recentEntries,
  appendRecent,
  recentDiagnosticEntries,
  appendDiagnosticEntry,
  log,
  subscribeLog,
  recentLogText,
  diagNote,
  diagStack,
  MAX_DURABLE_REJECTION_TRANSPORTS,
  isFailedHandshakeCheckpoint,
  retainRejectionTransport,
  rejectionTransportKey,
  PRODUCTION_PACKAGE_KEYS,
  PRESET_FILES,
  DEBUG_PRESET_FILES,
  require_protocol_constants,
  MIN_GAME_TIMEOUT_BLOCKS,
  MAX_GAME_TIMEOUT_BLOCKS,
  isValidGameTimeoutBlocks,
  packageFor,
  gameDisplayName,
  isCatalogGameType,
  DEFAULT_CATALOG_GAME_TYPE,
  REGISTERED_GAMES,
  decodePersistedGameState,
  restoreRegisteredGameHandState,
  snapshotRegisteredGameHand,
  restoreRegisteredGameHand,
  isProposalParameterValue,
  handProposalsEqual,
  describeReceivedProposal,
  settlementLabel,
  isErrorSettlementOutcome,
  parseSettlementShare,
  toUint8,
  toHexString,
  coinIdFromBytes,
  coerceToBytes,
  normalizeHexString,
  normalizeCoinStringHex,
  spend_bundle_to_clvm,
  formatMojos,
  encodeU64AsClvmHex,
  createComposeDraftState,
  applyHandProposalToComposeDraft,
  selectComposeGame,
  DEFAULT_GAME_TIMEOUT_BLOCKS,
  DEFAULT_CHANNEL_TIMEOUT_BLOCKS,
  DEFAULT_UNROLL_TIMEOUT_BLOCKS,
  channelStatusModelFromPayload,
  channelStatusPayloadFromModel,
  createSessionModel,
  normalizeSessionPresentation,
  EMPTY_GAME_TERMINAL_MODEL,
  isTerminalGameStatus,
  projectGameStatus,
  nextGameInstanceAfterLocalTurn,
  isUncancelledProposal,
  proposalOrigin,
  reduceProposalEvent,
  selectPendingProposal,
  selectProposalByLifecycle,
  selectIncomingProposal,
  selectIProposedHand,
  PRE_ACTIVE_CHANNEL_STATES,
  isPreCommitmentChannelStatus,
  selectSessionPhase,
  selectRestoreBlocked,
  selectDisplayedGameInstance,
  selectDashboardCoins,
  selectInertGameInterfaceForBetweenHandDialog,
  selectGameTabConnected,
  ABANDON_WAITING_STATES,
  isChannelAbandonable,
  selectGameDashboardView,
  selectStatusBarBalances,
  selectGameSessionView,
  selectGameSpecificView,
  requireWasmResult,
  validateChannelStatus,
  jsonParse,
  integersToBigInt,
  jsonStringify,
  canonicalizeFundingRequest,
  fundingRequestKey,
  providerScopeKey,
  providerOwnerKey,
  channelFundingKey,
  channelFundingTradeKey,
  channelFundingEntryKey,
  isFeeAttachmentCancellation,
  isRetiringFeeAttachment,
  feeAttachmentOperationKey,
  feeAttachmentEntryKey,
  feeAttachmentForSubmission,
  activeFeeAttachmentForSubmission,
  identifiedFeeAttachment,
  snapshotFromSessionModel,
  rehydrateDurableApplicationState,
  require_bencodex,
  StorageAuthorityLostError,
  StorageAuthorityRequiredError,
  isElectronDistribution,
  isLeaseConflict,
  releaseLeaseIfOwner,
  markSavedSession,
  clearSavedSessionMarker,
  clearGameSessionState,
  WalletProviderRegistry,
  walletProviderRegistry,
  isRecoverableProvider,
  canLosePreIdResponse,
  walletSessionKey,
  providerRequestFromRecovery,
  restoredFundingForSink,
  entryForOperation,
  walletRecoveryNotice,
  coalesceProviderFlight,
  advanceProviderCreation,
  advanceProviderCancellation,
  checkpointProviderState,
  runFundingCancellation,
  flushFundingCancellations,
  finishRetiredFundingCancellation,
  cancelRetiredWalletReservations,
  cancelRetiredWalletReservation,
  reloadAfterSuccessfulHardReset,
  startPendingWalletConnectWipe,
  _resetPendingWalletConnectWipeForTests,
  hardResetUnclaimedStorage,
  hardResetStorage,
  storageRepository,
  isTestnet,
  getCurrencyLabels
};
