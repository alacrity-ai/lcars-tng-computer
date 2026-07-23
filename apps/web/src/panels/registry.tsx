import type { ComponentType } from "react";
import type { PanelProps, PanelView } from "@tng/shared";
import { BootPanel } from "./BootPanel";
import { StatusPanel } from "./StatusPanel";
import { TextPanel } from "./TextPanel";
import { AlertPanel } from "./AlertPanel";
import { WeatherPanel } from "./WeatherPanel";
import { ResultsPanel } from "./ResultsPanel";
import { ArticlePanel } from "./ArticlePanel";
import { NewsPanel } from "./NewsPanel";
import { ChartPanel } from "./ChartPanel";
import { MapPanel } from "./MapPanel";
import { NightSkyPanel } from "./NightSkyPanel";
import { ImagePanel } from "./ImagePanel";
import { QuotePanel } from "./QuotePanel";
import { DiagramPanel } from "./DiagramPanel";
import { QuizPanel } from "./QuizPanel";
import { CodePanel } from "./CodePanel";
import { TablePanel } from "./TablePanel";
import { StepsPanel } from "./StepsPanel";
import { TimelinePanel } from "./TimelinePanel";
import { ScoreboardPanel } from "./ScoreboardPanel";
import { MathPanel } from "./MathPanel";

function BlankPanel() {
  return null;
}

/** TNGC-26: the actual player lives in PlaybackLayer (it must survive panel
    churn); the youtube "panel" is just the docking signal — the layer sees
    view === "youtube" and fills the content area itself. */
function YouTubeDock() {
  return null;
}

function UnknownPanel({ view }: { view: string }) {
  return <div className="text-panel-body">Panel “{view}” is not yet installed.</div>;
}

/** Total over PanelView on purpose: a view added to PANEL_VIEWS without a
    component here fails to compile, so `display` can never advertise a panel
    the wall can't draw. */
const REGISTRY: Record<PanelView, ComponentType<any>> = {
  boot: BootPanel,
  status: StatusPanel,
  text: TextPanel,
  alert: AlertPanel,
  blank: BlankPanel,
  weather: WeatherPanel,
  youtube: YouTubeDock,
  results: ResultsPanel,
  article: ArticlePanel,
  news: NewsPanel,
  chart: ChartPanel,
  map: MapPanel,
  "night-sky": NightSkyPanel,
  image: ImagePanel,
  quote: QuotePanel,
  diagram: DiagramPanel,
  quiz: QuizPanel,
  code: CodePanel,
  table: TablePanel,
  steps: StepsPanel,
  timeline: TimelinePanel,
  scoreboard: ScoreboardPanel,
  math: MathPanel,
};

export function Panel({ view, props }: { view: PanelView; props: PanelProps }) {
  // Still guarded at runtime: an older server can send a view this build
  // predates, and a stub beats a blank screen.
  const Component = REGISTRY[view];
  if (!Component) return <UnknownPanel view={view} />;
  return <Component {...props} />;
}
