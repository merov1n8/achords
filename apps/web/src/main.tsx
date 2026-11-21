import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { render } from "preact";
import { App } from "./app.tsx";
import { applyAppearance, loadAppearance } from "./theme.ts";
import "./styles.css";

// Apply the saved look before the first paint, and follow macOS day/night when set to System.
applyAppearance(loadAppearance());
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () =>
  applyAppearance(loadAppearance()),
);

render(<App />, document.getElementById("app") as HTMLElement);
