import { render } from "solid-js/web";
import { App } from "./App.jsx";
import { startTheme } from "./theme.js";
import "./theme.css";

startTheme();

const root = document.getElementById("root");
if (root === null) {
  throw new Error("missing #root");
}
render(() => <App />, root);
