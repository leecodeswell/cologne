// Builds the sculpture off the main thread, so the loader keeps animating.
import { buildSculpture } from "./sculpture.js";

self.onmessage = (e) => {
  const data = buildSculpture(e.data);
  self.postMessage(data, [data.position.buffer, data.motif.buffer, data.index.buffer]);
};
