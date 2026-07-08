import { useMemo } from "react";

// Known validator aliases (etherbase → short name)
const ALIAS = {
  "0x72b61c6014342d914470ec7ac2975be345796c2b": "BNB48",
  "0x26324d97c8f3e4e53ce359f8aed8495ae45b0d11": "Fuji",
  "0x4430b3230294d12c6ab2aac5c2cd68e80b16b581": "Legend",
  "0x9f8ccdafcc39f3c7d6ebf637c9151673cbc36b88": "HashKey",
  "0xe2d3a739effcd3a99387d015e260eefac72ebea1": "NodeReal",
  "0xb4dd66d7c2c7e57f628210187192fb89d4b99dd4": "Coinbase",
  "0x0bac492386862ad3df4b666bc096b0505bb694da": "Binance1",
  "0xf474cf03cceff28abc65c9cbae594f725c80e12d": "Binance2",
  "0x5a4f0c0a7f9ed2af5f0ef75dc5c8b5c23b1ab35f": "Binance3",
};

function shortAddr(addr) {
  if (!addr) return "??";
  const a = ALIAS[addr.toLowerCase()];
  if (a) return a;
  return addr.slice(2, 6).toUpperCase();
}

export default function ValidatorGrid({ nodeStats, slashStatus, latestBlock }) {
  const slashMap = useMemo(() => {
    const m = {};
    (slashStatus ?? []).forEach(v => { m[v.consensusAddr?.toLowerCase()] = v; });
    return m;
  }, [slashStatus]);

  // Derive validator list from nodeStats (miners) + slash list
  const validators = useMemo(() => {
    const set = new Map();
    (nodeStats ?? []).forEach(n => {
      if (!n.etherbase) return;
      const k = n.etherbase.toLowerCase();
      set.set(k, { addr: k, nodeType: n.nodeType, instance: n.instance, isMiner: true });
    });
    (slashStatus ?? []).forEach(v => {
      const k = v.consensusAddr?.toLowerCase();
      if (k && !set.has(k)) set.set(k, { addr: k, isMiner: false });
    });
    return [...set.values()];
  }, [nodeStats, slashStatus]);

  const slashed = (slashStatus ?? []).filter(v => v.slashCount > 0)
    .sort((a, b) => b.slashCount - a.slashCount);

  return (
    <div className="panel validator-panel">
      <div className="panel-header">
        <span>Validators</span>
        <span className="sub">{validators.length} nodes</span>
      </div>
      <div className="panel-body vgrid-body">
        <div className="vgrid">
          {validators.map(v => {
            const slash = slashMap[v.addr];
            const sc    = slash?.slashCount ?? 0;
            const cls   = sc === 0 ? "vdot-ok" : sc < 200 ? "vdot-warn" : sc < 600 ? "vdot-mis" : "vdot-fel";
            return (
              <div key={v.addr} className={`vdot ${cls}`} title={`${v.addr}\nSlash: ${sc}\n${v.nodeType ?? ""}`}>
                <span className="vdot-label">{shortAddr(v.addr)}</span>
              </div>
            );
          })}
        </div>

        {slashed.length > 0 && (
          <div className="slash-alerts">
            <div className="slash-title">⚡ SLASH ALERTS</div>
            {slashed.map(v => (
              <div key={v.consensusAddr} className={`slash-row ${v.slashCount >= 600 ? "slash-fel" : v.slashCount >= 200 ? "slash-mis" : "slash-warn"}`}>
                <span className="slash-name">{shortAddr(v.consensusAddr)}</span>
                <span className="slash-count">{v.slashCount}</span>
                <span className="slash-status">{v.status?.toUpperCase()}</span>
              </div>
            ))}
          </div>
        )}

        <div className="vgrid-legend">
          <LegItem cls="vdot-ok"  label="Normal" />
          <LegItem cls="vdot-warn" label="Warned" />
          <LegItem cls="vdot-mis" label="Misdemeanor" />
          <LegItem cls="vdot-fel" label="Felony" />
        </div>
      </div>
    </div>
  );
}

function LegItem({ cls, label }) {
  return (
    <div className="leg-item">
      <div className={`vdot ${cls}`} style={{ width: 8, height: 8, minWidth: 8 }} />
      <span>{label}</span>
    </div>
  );
}
