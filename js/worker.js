// Runs simulations off the main thread so large runs don't freeze the page.
import {simulate} from "./sim.js";

self.onmessage = e => {
  const {P, base} = e.data, parts = base ? 2 : 1;
  let done = 0;
  const progress = f => self.postMessage({type: "progress", value: (done + f) / parts});
  try {
    const A = simulate(P, true, progress);
    done = 1;
    const B = base ? simulate(P, false, progress) : null;
    self.postMessage({type: "done", A, B});
  } catch (err) {
    self.postMessage({type: "error", message: String(err && err.message || err)});
  }
};
