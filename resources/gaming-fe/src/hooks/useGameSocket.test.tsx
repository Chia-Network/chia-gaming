import { renderHook, act } from "@testing-library/react";
import { waitFor } from "@testing-library/dom";
import useGameSocket from "./useGameSocket";
import io from "socket.io-client";

jest.mock("socket.io-client");

describe("useGameSocket Hook", () => {
  let mockSocket: any;

  function fakeDeliverMsg(msg: string) { };

  beforeEach(() => {
    jest.clearAllMocks();

    mockSocket = {
      on: jest.fn(),
      emit: jest.fn(),
      off: jest.fn(),
      disconnect: jest.fn(),
    };

    (io as any).mockReturnValue(mockSocket);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("should initialize with correct default values", () => {
    const { result } = renderHook(() => useGameSocket(fakeDeliverMsg, () => { }));

    expect(result.current.gameState).toBe("idle");
    expect(result.current.wagerAmount).toBe("");
    expect(result.current.opponentWager).toBe("");
    expect(result.current.log).toEqual([]);
    expect(result.current.playerHand).toEqual([]);
    expect(result.current.opponentHand).toEqual([]);
    expect(result.current.playerCoins).toBe(100);
    expect(result.current.opponentCoins).toBe(100);
    expect(result.current.isPlayerTurn).toBe(false);
    expect(result.current.playerNumber).toBe(0);
  });

  test("should update gameState to searching on waiting event", () => {
    const { result } = renderHook(() => useGameSocket(fakeDeliverMsg, () => { }));

    const waitingCallback = mockSocket.on.mock.calls.find(
      (call: any) => call[0] === "waiting"
    )[1];

    act(() => {
      waitingCallback({});
    });

    expect(result.current.gameState).toBe("searching");
  });

  test("should handle startGame event correctly", () => {
    const { result } = renderHook(() => useGameSocket(fakeDeliverMsg, () => { }));

    const startGameCallback = mockSocket.on.mock.calls.find(
      (call: any) => call[0] === "startGame"
    )[1];

    const startGameData = {
      room: "room-1",
      playerHand: ["AS", "KD"],
      opponentHand: ["QC", "JH"],
      playerNumber: 1,
      opponentWager: "50",
      wagerAmount: "50",
      currentTurn: 1,
    };

    act(() => {
      startGameCallback(startGameData);
    });

    expect(result.current.gameState).toBe("playing");
    expect(result.current.playerHand).toEqual(["AS", "KD"]);
    expect(result.current.opponentHand).toEqual(["QC", "JH"]);
    expect(result.current.playerNumber).toBe(1);
    expect(result.current.opponentWager).toBe("50");
    expect(result.current.wagerAmount).toBe("50");
    expect(result.current.isPlayerTurn).toBe(true);
    expect(result.current.log).toContain("Opponent found! Starting game...");
  });

  test("should handle action events correctly", () => {
    const { result } = renderHook(() => useGameSocket(fakeDeliverMsg, () => { }));

    const startGameCallback = mockSocket.on.mock.calls.find(
      (call: any) => call[0] === "startGame"
    )[1];

    act(() => {
      startGameCallback({
        room: "room-1",
        playerHand: [],
        opponentHand: [],
        playerNumber: 1,
        opponentWager: "50",
        wagerAmount: "50",
        currentTurn: 1,
      });
    });

    const actionCallback = mockSocket.on.mock.calls.find(
      (call: any) => call[0] === "action"
    )[1];

    act(() => {
      actionCallback({
        type: "bet",
        amount: 10,
        actionBy: 1,
      });
    });

    expect(result.current.playerCoins).toBe(90);
    expect(result.current.log).toContain("You bet 10 coins.");

    act(() => {
      actionCallback({
        type: "bet",
        amount: 5,
        actionBy: 2,
      });
    });

    expect(result.current.opponentCoins).toBe(95);
    expect(result.current.log).toContain("Opponent bets 5 coins.");

    act(() => {
      actionCallback({
        type: "endTurn",
        actionBy: 1,
        currentTurn: 2,
      });
    });

    expect(result.current.isPlayerTurn).toBe(false);
    expect(result.current.log).toContain("You ended your turn.");

    act(() => {
      actionCallback({
        type: "move",
        actionBy: 2,
      });
    });

    expect(result.current.log).toContain("Opponent made a move.");
  });
});

