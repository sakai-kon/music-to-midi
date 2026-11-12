export const MODEL_STORAGE_KEY = "indexeddb://music-to-midi-basic-pitch-v1";

/**
 * Loads the Basic Pitch graph model from this browser's IndexedDB first.
 * On a cache miss (or an unavailable/corrupt cache), it downloads the model
 * and best-effort saves a copy for the next visit.
 */
export async function loadBasicPitchGraphModel(tf, modelUrl, onStatus = () => {}) {
  if (!tf || typeof tf.loadGraphModel !== "function") {
    throw new TypeError("A TensorFlow.js instance with loadGraphModel() is required.");
  }
  if (typeof modelUrl !== "string" || !modelUrl) {
    throw new TypeError("A valid model URL is required.");
  }

  onStatus("checking-cache");
  try {
    const cachedModel = await tf.loadGraphModel(MODEL_STORAGE_KEY);
    onStatus("loaded-cache");
    return cachedModel;
  } catch {
    // Missing, unavailable, or corrupt IndexedDB data should not prevent use.
    onStatus("downloading");
  }

  const downloadedModel = await tf.loadGraphModel(modelUrl);
  try {
    if (typeof downloadedModel.save !== "function") {
      throw new Error("This TensorFlow.js model does not support browser storage.");
    }
    await downloadedModel.save(MODEL_STORAGE_KEY);

    // Ask the browser to reduce the chance of automatic storage eviction.
    // This is best-effort: browsers may not implement or grant persistent storage.
    const storageManager = globalThis.navigator?.storage;
    if (typeof storageManager?.persist === "function") {
      try {
        await storageManager.persist();
      } catch {
        // The IndexedDB copy is still usable even if persistence cannot be granted.
      }
    }
    onStatus("saved");
  } catch (error) {
    // Keep the app usable in private browsing or when storage is unavailable.
    onStatus("save-failed", error);
  }

  return downloadedModel;
}
