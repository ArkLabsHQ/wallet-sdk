declare module "bip68" {
    export function encode(timelock: {
        blocks?: number;
        seconds?: number;
    }): number;

    export function decode(value: number): {
        blocks?: number;
        seconds?: number;
    };
}
