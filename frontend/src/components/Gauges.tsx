export function StressGauge({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color = value > 0.85 ? "#e06c66" : value > 0.65 ? "#d6a548" : "#5fb58a";
  const r = 44;
  const c = Math.PI * r; // half circle
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 120 70" className="w-full max-w-[220px]">
        <path d="M 16 64 A 44 44 0 0 1 104 64" fill="none" stroke="#26262c" strokeWidth="10" strokeLinecap="round" />
        <path d="M 16 64 A 44 44 0 0 1 104 64" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(pct / 100) * c} ${c}`} className="transition-all duration-700" />
        <text x="60" y="60" textAnchor="middle" fill="#e4e4e7" fontSize="24" fontWeight="600" fontFamily="JetBrains Mono, monospace">
          {pct}
        </text>
      </svg>
      <div className="text-[11px] text-zinc-500 -mt-1">Line stress</div>
    </div>
  );
}

export function NoiseMeter({ db, active }: { db: number; active: boolean }) {
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const bars = 20;
  const lit = Math.round((pct / 100) * bars);
  return (
    <div>
      <div className="flex items-end gap-[3px] h-10">
        {Array.from({ length: bars }).map((_, i) => {
          const on = active && i < lit;
          const color = i > 15 ? "bg-bad/80" : i > 11 ? "bg-warn/80" : "bg-ok/70";
          return <div key={i} className={`flex-1 rounded-sm transition-colors ${on ? color : "bg-ink-700"}`} style={{ height: `${30 + (i / bars) * 70}%` }} />;
        })}
      </div>
      <div className="flex justify-between text-[11px] text-zinc-500 mt-1">
        <span>Room noise</span>
        <span className="num text-zinc-400">{active ? `${db.toFixed(0)} dBFS` : "mic off"}</span>
      </div>
    </div>
  );
}

export function LevelMeter({ level }: { level: number }) {
  const pct = Math.min(100, level * 100);
  return (
    <div className="h-1.5 w-full rounded-full bg-ink-700 overflow-hidden">
      <div className={`h-full transition-[width] duration-75 ${pct > 85 ? "bg-bad/80" : pct > 60 ? "bg-warn/80" : "bg-ok/70"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
