import type { ScoreboardGame, ScoreboardPanelProps, ScoreboardTeam } from "@tng/shared";

function decided(game: ScoreboardGame): boolean {
  return (
    /^final/i.test(game.status ?? "") &&
    typeof game.away.score === "number" &&
    typeof game.home.score === "number" &&
    game.away.score !== game.home.score
  );
}

function TeamRow({ team, won, hero }: { team: ScoreboardTeam; won: boolean; hero: boolean }) {
  return (
    <div className={`score-team${won ? " winner" : ""}`}>
      <span className="score-team-name">
        {hero ? team.name : (team.abbrev ?? team.name)}
        {team.record && <span className="score-team-record">{team.record}</span>}
      </span>
      <span className="score-team-score">{typeof team.score === "number" ? team.score : "–"}</span>
    </div>
  );
}

function GameCard({ game, hero }: { game: ScoreboardGame; hero: boolean }) {
  const done = decided(game);
  const awayWon = done && game.away.score! > game.home.score!;
  const homeWon = done && game.home.score! > game.away.score!;
  return (
    <div className={`score-card${hero ? " hero" : ""}`}>
      <div className={`score-status${game.live ? " live" : ""}`}>{game.status}</div>
      <TeamRow team={game.away} won={awayWon} hero={hero} />
      <TeamRow team={game.home} won={homeWon} hero={hero} />
      {game.note && <div className="score-note">{game.note}</div>}
    </div>
  );
}

export function ScoreboardPanel({ title, games, caption }: ScoreboardPanelProps) {
  const list = Array.isArray(games) ? games : [];
  if (!list.length) {
    return <div className="score-panel-empty">No games to display.</div>;
  }

  const hero = list.length === 1;
  return (
    <div className="score-panel">
      {title && <div className="score-title">{title}</div>}
      <div className={`score-grid${hero ? " single" : ""}`}>
        {list.map((game, i) => (
          <GameCard key={i} game={game} hero={hero} />
        ))}
      </div>
      {caption && <div className="score-caption">{caption}</div>}
    </div>
  );
}
