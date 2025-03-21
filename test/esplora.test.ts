import { describe, it, expect, vi, beforeEach } from "vitest";
import { EsploraProvider, Coin } from "../src";
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
});
