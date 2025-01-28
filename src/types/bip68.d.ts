declare module "bip68" {
    export function encode(timelock: {
        blocks?: number;
        seconds?: number;
    }): number;
}
