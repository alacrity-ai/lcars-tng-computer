import type { ComponentType } from "react";
import type { PanelProps, PanelView } from "@tng/shared";
import { BootPanel } from "./BootPanel";
import { StatusPanel } from "./StatusPanel";
import { TextPanel } from "./TextPanel";
import { AlertPanel } from "./AlertPanel";
import { WeatherPanel } from "./WeatherPanel";
import { YouTubePanel } from "./YouTubePanel";
import { ResultsPanel } from "./ResultsPanel";
import { ArticlePanel } from "./ArticlePanel";
import { NewsPanel } from "./NewsPanel";
import { ChartPanel } from "./ChartPanel";
import { MapPanel } from "./MapPanel";
import { ImagePanel } from "./ImagePanel";
import { QuotePanel } from "./QuotePanel";
import { DiagramPanel } from "./DiagramPanel";

function BlankPanel() {
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
  youtube: YouTubePanel,
  results: ResultsPanel,
  article: ArticlePanel,
  news: NewsPanel,
  chart: ChartPanel,
  map: MapPanel,
  image: ImagePanel,
  quote: QuotePanel,
  diagram: DiagramPanel,
};

export function Panel({ view, props }: { view: PanelView; props: PanelProps }) {
  // Still guarded at runtime: an older server can send a view this build
  // predates, and a stub beats a blank screen.
  const Component = REGISTRY[view];
  if (!Component) return <UnknownPanel view={view} />;
  return <Component {...props} />;
}
