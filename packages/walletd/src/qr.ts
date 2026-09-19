/**
 * Receive-side QR: encode the wallet address for the panel (PNG data URL)
 * and the terminal (ANSI art). Pure functions of the address string —
 * no wallet, no network.
 */
import { toDataURL, toString as toAscii } from "qrcode";

/** PNG data URL (~240px) for QML Image sources (`bsv address --png`). */
export async function qrDataUrl(address: string): Promise<string> {
  return toDataURL(address, { width: 240, margin: 1 });
}

/** ANSI-art QR for terminals (`bsv address --qr`). */
export async function qrAscii(address: string): Promise<string> {
  return toAscii(address, { type: "terminal", small: true });
}
