declare module "noise-handshake" {
  const NoiseDefault: unknown;
  export default NoiseDefault;
}
declare module "noise-handshake/cipher.js" {
  const CipherDefault: unknown;
  export default CipherDefault;
}
declare module "noise-handshake/dh.js" {
  export function generateKeyPair(privKey?: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array };
}
