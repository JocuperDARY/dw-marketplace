#!/usr/bin/env node
// Tool-Proact T4 Embedding Layer — optional Transformers.js integration
// Auto-detects @huggingface/transformers. Falls back gracefully.
// Model: Xenova/all-MiniLM-L6-v2 (23MB, 384-dim, multilingual)

'use strict';

let pipeline = null;
let modelLoaded = false;
let loadError = null;

function isAvailable() {
  try {
    require.resolve('@xenova/transformers');
    return true;
  } catch { return false; }
}

async function ensureModel() {
  if (modelLoaded) return true;
  if (loadError) return false;
  if (!isAvailable()) { loadError = 'not installed'; return false; }

  try {
    const { pipeline: pp } = require('@xenova/transformers');
    pipeline = await pp('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    modelLoaded = true;
    console.error('[embedding] T4 model loaded: all-MiniLM-L6-v2');
    return true;
  } catch (e) {
    loadError = e.message;
    console.error('[embedding] T4 load failed, falling back to TF-IDF:', e.message);
    return false;
  }
}

async function encode(text) {
  if (!(await ensureModel())) return null;
  try {
    const result = await pipeline(text, { pooling: 'mean', normalize: true });
    const list = result.tolist ? result.tolist() : result.data;
    const flat = Array.isArray(list[0]) ? list[0] : list;
    return Array.from(flat);
  } catch (e) {
    console.error('[embedding] encode error:', e.message);
    return null;
  }
}

async function encodeBatch(texts) {
  if (!(await ensureModel())) return null;
  try {
    const result = await pipeline(texts, { pooling: 'mean', normalize: true });
    const list = result.tolist ? result.tolist() : result.data;
    return list.map(v => Array.from(v));
  } catch (e) {
    console.error('[embedding] batch encode error:', e.message);
    return null;
  }
}

function dotProduct(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // normalized vectors: dot = cosine
}

function embeddingSearch(queryVec, docEmbeddings, topN) {
  topN = topN || 10;
  const results = [];
  for (const doc of docEmbeddings) {
    if (!doc.embedding || doc.embedding.length === 0) continue;
    results.push({ id: doc.id, sim: dotProduct(queryVec, doc.embedding) });
  }
  results.sort((a, b) => b.sim - a.sim);
  return results.slice(0, topN);
}

module.exports = { isAvailable, ensureModel, encode, encodeBatch, embeddingSearch };
