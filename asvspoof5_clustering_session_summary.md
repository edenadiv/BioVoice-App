# ASVspoof5 32-System Spoof Classifiers — Session Context & Findings

> **How to use this file**: If you're starting a new Claude Code session in a
> different workspace/folder and want it to understand this project's
> spoof-detection pipeline, paste this whole file as your first message (or
> point Claude at it with `Read docs/asvspoof5_clustering_session_summary.md`
> if the session has access to this repo). It captures the project setup,
> what's been built, the experiments run, and the conclusions reached.

## 1. Project context

**BioVoice** is a voice-deepfake/spoof-detection app. The detection backend is
trained on the **ASVspoof5** dataset, which contains bonafide speech plus
spoofed speech from **32 attack systems (A01-A32)**:

- `A01-A08` — train partition
- `A09-A16` — dev partition
- `A17-A32` — eval partition (the hardest / most out-of-domain attacks,
  including 9 zero-shot TTS/VC systems and 7 **adversarial** attacks that
  specifically target anti-spoofing models)

The full per-system attack taxonomy (algorithm, vocoder, speaker encoder,
category, description) was transcribed from the official ASVspoof5 evaluation
plan into:

**`asvspoof5_attack_system_descriptions.csv`** (repo root, 32 rows)
Columns: `system_id, partition, algorithm, category, vocoder, speaker_encoder,
base_system, description`. `base_system` links derivative attacks to their
parent (e.g. `A26 -> A16`, `A18 -> A17`, `A30 -> A18`).

Categories used: Neural TTS - Flow / Diffusion / Feedforward / Flow
(end-to-end) / Conformer / Autoregressive / Pretrained (external data);
Concatenative / Unit-selection; Voice Conversion - GAN / Disentanglement /
Diffusion; Adversarial - Malafide / Malacopula / Malacopula+Malafide.

## 2. Three embedding backbones evaluated

| Backbone | Notebook (32 specialists) | Output dir (on server `/home/SpeakerRec/BioVoice`) |
|---|---|---|
| **ECAPA-TDNN** (SpeechBrain) | `ecapa/logistic_regression/asvspoof5/all_32_systems/train_logistic_ecapa_all32.ipynb` | `data/models/ecapa_asvspoof5_32_systems/` |
| **ReDimNet** | `redimnet/logistic_regression/asvspoof5/all_32_systems/...ipynb` | `data/models/redimnet_asvspoof5_32_systems/` |
| **ResNet-293** (WeSpeaker) | `resnet_293/logistic_regression/asvspoof5/all_32_systems/train_logistic_resnet293_all32.ipynb` | `data/models/resnet293_asvspoof5_32_systems/` |

For each backbone, each notebook trains **32 binary logistic-regression
specialists** (`bonafide vs A_i`), one per attack system, saving
`scaler.pkl` + `logistic_regression.pkl` + `run_summary.json` +
`predictions.csv` per system, plus a `metrics_summary.csv` with
train/test accuracy & AUC for all 32.

**Conclusion reached: ECAPA-TDNN is the best backbone overall** — highest AUC
as specialists, as a pooled universal classifier, and as grouped/clustered
classifiers, both across all 32 systems and on the hard eval-only systems
(A17-A32).

## 3. Pooled "universal" classifier

`train_pooled_universal_32_systems.ipynb` trains **one** classifier per
backbone (bonafide vs. all spoof systems pooled together). Works reasonably
but loses attack-family structure — grouped/clustered classifiers do better,
especially on A17-A32. (Open caveat, not yet addressed: class imbalance —
could try `class_weight='balanced'`.)

## 4. Grouped "family" classifiers via cross-system clustering

**Notebook: `train_grouped_clusters_32_systems.ipynb`** (repo root, 11 cells
total: md-00, cell-01..cell-08, md-06, md-07)

Output dir: `data/models/grouped_clusters_32_systems/<Backbone>/`

### Methodology
1. For each backbone, build a **32x32 cross-system AUC matrix**: each
   system's specialist (`bonafide vs A_i`) is scored on every other system
   `A_j`'s bonafide+spoof test set.
2. `distance = 1 - symmetrized(cross_AUC)` → hierarchical clustering
   (`scipy.cluster.hierarchy.linkage`, method='average').
3. Cut the dendrogram at `K = N_CLUSTERS` (`fcluster`, `criterion='maxclust'`)
   to get cluster assignments.
4. Train **one classifier per cluster** (bonafide vs. pooled spoof samples
   from every system in that cluster). Saves `scaler.pkl` +
   `logistic_regression.pkl` + `members.json` under `cluster_<id>/`.
5. Compare each cluster classifier's AUC per system vs. that system's
   specialist AUC → `cluster_vs_specialist_summary.csv`.

### K-sweep (K=2..10) — finding each backbone's natural cluster count

Re-cuts the dendrogram at K=2..10, retrains, and tracks mean AUC drop vs.
specialists (overall and restricted to A17-A32 eval systems):

| Backbone | mean_drop_all @K=6 | @K=7 | @K=8 | Elbow |
|---|---|---|---|---|
| **ECAPA** | 0.0045 | **0.0025** | 0.0020 | **K=7** — eval drop nearly halves (0.0081→0.0045) then plateaus |
| ReDimNet | 0.0043 | 0.0041 | 0.0036 | gradual, no sharp elbow |
| ResNet293 | 0.0148 | 0.0123 | 0.0088 | gradual, much higher drops overall |

→ **Chose `N_CLUSTERS = 7`** for all backbones (ECAPA's elbow). Cell-02 was
updated accordingly and the notebook re-run, producing 7 trained cluster
models per backbone under `grouped_clusters_32_systems/<Backbone>/cluster_1..7/`.

Mean AUC drop (specialist → 7-cluster) per backbone:
- ECAPA: **0.0025** (best)
- ReDimNet: 0.0041
- ResNet293: 0.0123

### Semantic cluster labels (cell-08)

Cell-08 cross-references each cluster's `members.json` against
`asvspoof5_attack_system_descriptions.csv` and writes
`grouped_clusters_32_systems/cluster_semantic_labels.csv` with a
human-readable label per cluster (columns: backbone, cluster_id, members,
cluster_size, dominant_category, category_breakdown, suggested_label).

#### ECAPA K=7 clusters — final chosen configuration

| Cluster | Members | Label |
|---|---|---|
| 1 | A12, A19 | Concatenative / Unit-selection |
| 2 | A18, A20, A23, A27, A30, A31, A32 (7) | **All adversarial** (Malafide + Malacopula filters targeting CMs/ASV) |
| 3 | A16, A26 | Voice Conversion - Disentanglement |
| 4 | A08, A17, A29 | VITS / ZMM-TTS / XTTS (high-fidelity / externally-pretrained) |
| 5 | A09, A10, A21, A22 | Neural TTS - Conformer (IMS Toucan family, incl. BigVGAN variants) |
| 6 | A01-07, A11, A13-15, A24, A25 (13) | Mixed — generic neural TTS/VC catch-all |
| 7 | A28 | Neural TTS - Pretrained (external data) — hardest system across ALL backbones |

ECAPA's clusters are notably **cleaner/more semantically coherent** than
ReDimNet's or ResNet293's at K=7 (ReDimNet has one giant 21-system "Mixed"
cluster; ResNet293 splits adversarial systems across multiple mixed
clusters). This reinforces ECAPA as the right choice not just for AUC but
also for **explainability** in the app's UI.

#### ReDimNet K=7 (for comparison)
- cl1 (21 systems): Mixed, dominant Neural TTS-Conformer
- cl2: A26 (VC-Disentanglement)
- cl3: A17 (TTS-Pretrained)
- cl4: A28 (TTS-Pretrained)
- cl5: A18,A20,A27,A30,A31,A32 (Mixed, dominant Adversarial-Malacopula)
- cl6: A12, cl7: A19 (both Concatenative/Unit-selection, split apart)

#### ResNet293 K=7 (for comparison)
- cl1 (10 systems incl. A12,A14,A18-A20,A23,A27,A30-32): Mixed, dominant Adversarial-Malafide
- cl2: A22,A24 / cl3: A13,A25 / cl4: A11,A15,A16,A26 (Mixed VC)
- cl5: A17,A29 (TTS-Pretrained) / cl6 (11 systems): Mixed Neural TTS-Flow / cl7: A28

## 5. Strategic recommendation for the app

- Use **ECAPA-TDNN** as the embedding backbone.
- Use the **K=7 grouped cluster classifiers** (not per-system specialists,
  not the single pooled model) as the production spoof detectors — best
  tradeoff of accuracy (AUC drop vs. specialists only 0.0025) and
  explainability (7 semantically-coherent attack-family groups).
- For the app's "why was this flagged as spoof" UI, surface the
  `suggested_label` from `cluster_semantic_labels.csv` for whichever cluster
  fired (e.g. "Adversarial filtering attack", "Concatenative/unit-selection
  TTS", "Conformer-based zero-shot TTS", etc.).
- Open judgment call (not yet decided): whether to collapse cluster 2's
  "Mixed (Malafide/Malacopula)" label into a single simpler "Adversarial
  attack" label for the UI, and similarly simplify cluster 6's generic
  "Mixed neural TTS/VC" label.

## 6. Artifacts produced this session

- `asvspoof5_attack_system_descriptions.csv` (repo root) — AXX → attack
  taxonomy lookup, canonical reference for any future labeling work.
- `train_grouped_clusters_32_systems.ipynb` — extended with K-sweep
  (cell-06/07) and semantic-labeling (md-07/cell-08), `N_CLUSTERS` set to 7.
- `grouped_clusters_32_systems/k_sweep_summary.csv`,
  `k_sweep_auc_drop.png`, `cluster_semantic_labels.csv`,
  `all_backbones_cluster_vs_specialist.csv` (all on server under
  `data/models/grouped_clusters_32_systems/`).

## 7. Open / not-yet-done items

- Build an ensemble-eval notebook testing max/mean `p_spoof` across the 7
  ECAPA cluster models vs. the pooled universal model on held-out data, to
  validate real-world (non-oracle, i.e. without knowing which cluster a
  sample "should" belong to) performance.
- Address class imbalance in the pooled universal notebook
  (`class_weight='balanced'`).
- Decide on final UI label wording for clusters 2 and 6 (see §5).
- Wire the 7 ECAPA cluster models + `cluster_semantic_labels.csv` into the
  actual BioVoice app inference/explainability pipeline.

## 8. Environment notes

- Heavy compute (embedding extraction, training, notebook execution) runs on
  a remote SSH server at `/home/SpeakerRec/BioVoice` via `tmux` +
  `jupyter nbconvert --to notebook --execute --inplace
  --ExecutePreprocessor.timeout=-1 <notebook>.ipynb`.
- Local repo: `C:\Users\yoav1\לימודים\year4\final\BioVoice` (this is also
  synced/mirrored to the server path above — same relative structure).
