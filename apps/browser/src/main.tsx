import { render } from "solid-js/web";
import { App } from "./App.jsx";
import "./theme.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("missing #root");
}
render(() => <App />, root);
