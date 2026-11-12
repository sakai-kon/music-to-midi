import test from "node:test";
import assert from "node:assert/strict";

import {
  loadBasicPitchGraphModel,
  MODEL_STORAGE_KEY
} from "../src/model-storage.js";

test("loads a model from IndexedDB without downloading it again", async () => {
  const cachedModel = { source: "indexeddb" };
  const requests = [];
  const statuses = [];
  const tf = {
    async loadGraphModel(source) {
      requests.push(source);
      if (source === MODEL_STORAGE_KEY) return cachedModel;
      throw new Error("Network should not be used for a cache hit.");
    }
  };

  const result = await loadBasicPitchGraphModel(tf, "/models/model.json", (status) => {
    statuses.push(status);
  });

  assert.equal(result, cachedModel);
  assert.deepEqual(requests, [MODEL_STORAGE_KEY]);
  assert.deepEqual(statuses, ["checking-cache", "loaded-cache"]);
});

test("downloads and saves the model when IndexedDB has no saved copy", async () => {
  const downloadedModel = {
    savedTo: null,
    async save(target) {
      this.savedTo = target;
    }
  };
  const requests = [];
  const statuses = [];
  const tf = {
    async loadGraphModel(source) {
      requests.push(source);
      if (source === MODEL_STORAGE_KEY) throw new Error("No saved model.");
      return downloadedModel;
    }
  };

  const result = await loadBasicPitchGraphModel(tf, "/models/model.json", (status) => {
    statuses.push(status);
  });

  assert.equal(result, downloadedModel);
  assert.deepEqual(requests, [MODEL_STORAGE_KEY, "/models/model.json"]);
  assert.equal(downloadedModel.savedTo, MODEL_STORAGE_KEY);
  assert.deepEqual(statuses, ["checking-cache", "downloading", "saved"]);
});

test("continues when the browser cannot persist the downloaded model", async () => {
  const downloadedModel = {
    async save() {
      throw new Error("IndexedDB is unavailable.");
    }
  };
  const statuses = [];
  const tf = {
    async loadGraphModel(source) {
      if (source === MODEL_STORAGE_KEY) throw new Error("No saved model.");
      return downloadedModel;
    }
  };

  const result = await loadBasicPitchGraphModel(tf, "/models/model.json", (status) => {
    statuses.push(status);
  });

  assert.equal(result, downloadedModel);
  assert.deepEqual(statuses, ["checking-cache", "downloading", "save-failed"]);
});

test("reports a network/model download error instead of hiding it", async () => {
  const downloadError = new Error("Model download failed.");
  const tf = {
    async loadGraphModel(source) {
      if (source === MODEL_STORAGE_KEY) throw new Error("No saved model.");
      throw downloadError;
    }
  };

  await assert.rejects(
    loadBasicPitchGraphModel(tf, "/models/model.json"),
    (error) => error === downloadError
  );
});
