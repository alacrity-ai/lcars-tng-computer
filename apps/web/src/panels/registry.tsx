import type { ComponentType } from "react";
import type { PanelProps, PanelView } from "@tng/shared";
import { BootPanel } from "./BootPanel";
import { StatusPanel } from "./StatusPanel";
import { TextPanel } from "./TextPanel";
import { AlertPanel } from "./AlertPanel";

function BlankPanel() {
  return null;
}

function UnknownPanel({ view }: { view: string }) {
  return <div className="text-panel-body">Panel “{view}” is not yet installed.</div>;
}

const REGISTRY: Partial<Record<PanelView, ComponentType<any>>> = {
  boot: BootPanel,
  status: StatusPanel,
  text: TextPanel,
  alert: AlertPanel,
  blank: BlankPanel,
};

export function Panel({ view, props }: { view: PanelView; props: PanelProps }) {
  const Component = REGISTRY[view];
  if (!Component) return <UnknownPanel view={view} />;
  return <Component {...props} />;
}
