import QR from "qrcode";
import { useEffect, useState } from "react";

/** Renders `text` as a QR code (SVG data URL) — used for the phone sound board link. */
export function QrCode({ text, size = 140, className = "" }: { text: string; size?: number; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QR.toDataURL(text, { margin: 1, width: size, color: { dark: "#fafafa", light: "#121214" }, errorCorrectionLevel: "M" })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [text, size]);
  if (!src) return <div className={`rounded-lg bg-ink-800 ${className}`} style={{ width: size, height: size }} />;
  return <img src={src} width={size} height={size} alt={`QR code for ${text}`} className={`rounded-lg ${className}`} />;
}
