import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EsploraProvider, Coin } from "../src";
import {
    ExplorerTransaction,
    SubscribeMessage,
    WebSocketMessage,
} from "../src/providers/onchain";

// Mock WebSocket
class MockWebSocket {
    url: string;
    listeners: Map<string, (event: any) => void> = new Map();
    send = vi.fn();
    close = vi.fn();

    constructor(url: string) {
        this.url = url;
    }

    addEventListener(event: string, callback: (event: any) => void) {
        this.listeners.set(event, callback);
    }

    // Simulate WebSocket events
    simulateEvent(event: string, data: any) {
        const callback = this.listeners.get(event);
        if (callback) callback(data);
    }
}

// Define a type for the mock to satisfy TypeScript
type MockWebSocketInstance = InstanceType<typeof MockWebSocket>;

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("EsploraProvider", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    describe("getCoins", () => {
        const mockUTXOs: Coin[] = [
            {
                txid: "1234",
                vout: 0,
                value: 100000,
                status: {
                    confirmed: true,
                    block_height: 100,
                    block_hash: "abcd",
                    block_time: 1600000000,
                },
            },
        ];

        it("should fetch and convert UTXOs to coins", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockUTXOs),
            });

            const provider = new EsploraProvider("http://localhost:3000");
            const utxos = await provider.getCoins("bc1qtest");

            expect(mockFetch).toHaveBeenCalledWith(
                "http://localhost:3000/address/bc1qtest/utxo"
            );
            expect(utxos).toEqual(mockUTXOs);
        });

        it("should throw error on failed fetch", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                statusText: "Not Found",
            });

            const provider = new EsploraProvider("http://localhost:3000");
            await expect(provider.getCoins("bc1qtest")).rejects.toThrow(
                "Failed to fetch UTXOs: Not Found"
            );
        });
    });

    describe("getFeeRate", () => {
        const mockFeeResponse = {
            fastestFee: 100,
            halfHourFee: 80,
            hourFee: 60,
            economyFee: 40,
            minimumFee: 20,
        };

        it("should fetch and return fee rate", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockFeeResponse),
            });

            const provider = new EsploraProvider("http://localhost:3000");
            const feeRate = await provider.getFeeRate();

            expect(mockFetch).toHaveBeenCalledWith(
                "http://localhost:3000/v1/fees/recommended"
            );
            expect(feeRate).toBe(80); // halfHourFee
        });

        it("should throw error on failed fetch", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                statusText: "Service Unavailable",
            });

            const provider = new EsploraProvider("http://localhost:3000");
            await expect(provider.getFeeRate()).rejects.toThrow(
                "Failed to fetch fee rate: Service Unavailable"
            );
        });
    });

    describe("broadcastTransaction", () => {
        const mockTxHex = "0200000001...";
        const mockTxid = "abcd1234";

        it("should broadcast transaction and return txid", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(mockTxid),
            });

            const provider = new EsploraProvider("http://localhost:3000");
            const txid = await provider.broadcastTransaction(mockTxHex);

            expect(mockFetch).toHaveBeenCalledWith(
                "http://localhost:3000/tx",
                expect.objectContaining({
                    method: "POST",
                    headers: { "Content-Type": "text/plain" },
                    body: mockTxHex,
                })
            );
            expect(txid).toBe(mockTxid);
        });

        it("should throw error on failed broadcast", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                statusText: "Bad Request",
                text: () => Promise.resolve("Invalid transaction"),
            });

            const provider = new EsploraProvider("http://localhost:3000");
            await expect(
                provider.broadcastTransaction(mockTxHex)
            ).rejects.toThrow(
                "Failed to broadcast transaction: Invalid transaction"
            );
        });
    });

    describe("watchAddresses", () => {
        const callback = vi.fn();
        let provider: EsploraProvider;
        const baseUrl = "http://localhost:3000";
        const wsUrl = "ws://localhost:3000/v1/ws";
        const addresses = ["addr1", "addr2"];
        const transactions: ExplorerTransaction[] = [
            {
                txid: "tx1",
                vout: [{ scriptpubkey_address: addresses[0], value: "1000" }],
                status: { confirmed: false, block_time: 123 },
            },
            {
                txid: "tx2",
                vout: [{ scriptpubkey_address: addresses[1], value: "2000" }],
                status: { confirmed: true, block_time: 124 },
            },
        ];

        beforeEach(() => {
            provider = new EsploraProvider(baseUrl);
            vi.spyOn(provider, "getTransactions").mockImplementation(
                async () => []
            );
            vi.stubGlobal("WebSocket", MockWebSocket);
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
            vi.useRealTimers();
        });

        it("connects to the correct WebSocket URL", async () => {
            // arrange
            const conn = (await provider.watchAddresses(
                addresses,
                callback
            )) as unknown as MockWebSocketInstance;

            // assert
            expect(conn.url).toBe(wsUrl);
            expect(conn.close).toBeDefined();
            expect(callback).not.toHaveBeenCalled();
        });

        it("sends subscription message on WebSocket open", async () => {
            // arrange
            const conn = (await provider.watchAddresses(
                addresses,
                callback
            )) as unknown as MockWebSocketInstance;

            // act
            conn.simulateEvent("open", {});

            // assert
            const expectedMsg: SubscribeMessage = {
                "track-addresses": addresses,
            };
            expect(conn.send).toHaveBeenCalledWith(JSON.stringify(expectedMsg));
            expect(callback).not.toHaveBeenCalled();
        });

        it("processes valid WebSocket message and calls callback with transactions", async () => {
            // arrange
            const message: WebSocketMessage = {
                "multi-address-transactions": {
                    [addresses[0]]: {
                        mempool: [transactions[0]],
                        confirmed: [],
                        removed: [],
                    },
                    [addresses[1]]: {
                        mempool: [],
                        confirmed: [transactions[1]],
                        removed: [],
                    },
                },
            };

            const conn = (await provider.watchAddresses(
                addresses,
                callback
            )) as unknown as MockWebSocketInstance;

            // act
            conn.simulateEvent("message", { data: JSON.stringify(message) });

            // assert
            expect(callback).toHaveBeenCalledWith(
                transactions,
                expect.any(Function)
            );
        });

        it("ignores invalid WebSocket messages", async () => {
            // arrange
            const conn = (await provider.watchAddresses(
                addresses,
                callback
            )) as unknown as MockWebSocketInstance;

            // act
            conn.simulateEvent("message", { data: "invalid json" });

            // assert
            expect(callback).not.toHaveBeenCalled();
        });

        it("ignores messages without multi-address-transactions", async () => {
            // assert
            const conn = (await provider.watchAddresses(
                addresses,
                callback
            )) as unknown as MockWebSocketInstance;

            // act
            conn.simulateEvent("message", { data: JSON.stringify({}) });

            // assert
            expect(callback).not.toHaveBeenCalled();
        });

        it("falls back to polling on WebSocket error", async () => {
            const initialTxs: ExplorerTransaction[] = [transactions[0]];
            const newTxs: ExplorerTransaction[] = [transactions[1]];

            vi.spyOn(provider, "getTransactions")
                .mockResolvedValueOnce(initialTxs) // initial fetch for addr1
                .mockResolvedValueOnce([]) // initial fetch for addr2
                .mockResolvedValueOnce([...initialTxs, ...newTxs]) // polling fetch for addr1
                .mockResolvedValueOnce([]); // polling fetch for addr2

            const conn = (await provider.watchAddresses(
                addresses,
                callback
            )) as unknown as MockWebSocketInstance;

            // act
            conn.simulateEvent("error", {});

            // assert
            expect(provider.getTransactions).toHaveBeenCalledTimes(2); // once per address
            expect(callback).not.toHaveBeenCalled();

            // Simulate polling after 5 seconds
            await vi.advanceTimersByTimeAsync(5000);
            expect(callback).toHaveBeenCalledWith(newTxs, expect.any(Function));
        });
    });
});
