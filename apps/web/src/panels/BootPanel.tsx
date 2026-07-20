const BOOT_LINES = [
  "Isolinear subprocessors",
  "Main computer core access",
  "Library computer access and retrieval system",
  "Audio interface",
  "Subspace transceiver array",
];

export function BootPanel() {
  return (
    <div className="boot-panel">
      <div>
        <div className="boot-wordmark">TNG Computer</div>
        <div className="boot-sub">United Federation of Planets</div>
      </div>
      <div className="boot-lines">
        {BOOT_LINES.map((line, i) => (
          <div key={line} className="line" style={{ animationDelay: `${0.4 + i * 0.35}s` }}>
            {line}
            <span className="ok">Online</span>
          </div>
        ))}
      </div>
      <div className="boot-standby">Standing by</div>
    </div>
  );
}
