# Plan: Fix Kimi K2.6 Agentic Looping di 9Router

> Status: PLAN (belum ada kode yang diedit). Dokumen ini = blueprint implementasi + strategi try-n-error + lokasi unit test.

---

## 1. Masalah

Saat task agentic kompleks (contoh: "https://www.react.doctor/docs ini pahami detail"), `nvidia/moonshotai/kimi-k2.6` masuk loop tak terbatas:
- 191 tool calls, 28m58s, fetch URL yang sama berulang-ulang.
- Subagent "Build" tidak pernah selesai / harus di-interrupt manual.

Kimi K2.6 adalah model reasoning kuat (top-tier BridgeBench). Jadi ini **bukan keterbatasan model** — ini masalah **cara request di-deliver** oleh router + framing task.

---

## 2. Root Cause (hasil audit codebase + riset)

### RC-1 (PRIMARY): `tool_choice` dipaksa `"required"` — model tak bisa berhenti
`open-sse/executors/default.js:~325` memaksa `tool_choice: "required"` untuk Kimi K2.6 di NVIDIA.

Konsekuensi struktural: dengan `required`, model **WAJIB** memanggil tool di SETIAP turn dan **tidak pernah punya jalan untuk emit jawaban final**. Inilah akar loop — secara desain model dilarang berhenti.

Dilema yang ditemukan dari curl test sebelumnya:
- `tool_choice:"required"` → tool call valid (format OpenAI native) TAPI tak bisa stop → **loop**.
- `tool_choice:"auto"` → bisa stop TAPI output teks garbage (campuran karakter acak).

Maka fix sejati harus menyelesaikan dilema ini, bukan sekadar memilih salah satu.

### RC-2: Tidak ada termination contract
Task dari client ("pahami detail") bersifat **goal-ambiguous** — tidak ada definisi "done". Sesuai riset (Meritshot), ini Pattern-1 looping. Router tidak menyuntik kondisi terminasi apa pun.

### RC-3: `reasoning_content` tak terinjeksi untuk path NVIDIA (penyebab garbage DAN kehilangan kontinuitas multi-turn)
`open-sse/utils/reasoningContentInjector.js` (verified): `injectReasoningContent` memilih rule via `MODEL_RULES.find(r => r.match(model))` dengan regex `/^kimi-/i`. Untuk path NVIDIA `model = "moonshotai/kimi-k2.6"` → `/^kimi-/i.test("moonshotai/kimi-k2.6")` = **false** (ada prefix `moonshotai/`). Jadi `reasoning_content` **tidak pernah** diinjeksi.

Dampak dua arah:
- **Single-turn**: thinking model Moonshot butuh `reasoning_content` non-kosong pada assistant ber-tool_calls → bila hilang, output rusak/garbage (menjelaskan kenapa `auto` garbage).
- **Multi-turn (penting)**: pada turn ke-N, history assistant turn sebelumnya tak punya `reasoning_content` → model kehilangan jejak reasoning-nya sendiri → re-plan dari nol (lihat RC-5).

### RC-4: `max_tokens` default
Riset Moonshot: `finish_reason:"length"` (max_tokens kekecilan) → cyclic/repeated invocation. Perlu pastikan request Kimi NVIDIA punya `max_tokens` memadai (`runtimeConfig.js` sudah punya `DEFAULT_MAX_TOKENS=64000`).

### RC-5: Memory-less replanning — model mengulang urutan tool call IDENTIK (bukti dari trace produksi)
Trace nyata menunjukkan model mengulang **urutan persis sama** berkali-kali:
```
WebFetch /docs → WebFetch /run-your-first-scan → WebFetch /install-for-coding-agents → bash `npx react-doctor` → (kadang Read/Edit AGENTS.md) → ULANG dari awal
```
Model SUDAH membuat progress (menulis AGENTS.md, menjalankan scan) tapi tetap restart urutan awal. Sesuai riset Meritshot ini **Pattern-3: memory-less replanning** + **Pattern-2: tool output misinterpretation**. Penyebabnya adalah kompon dari RC-1 (`required` → tak bisa stop) + RC-3 (jejak reasoning hilang antar-turn → tak "ingat" sudah mengerjakan).

**Catatan kunci**: task framing dari client (react.doctor) SUDAH sangat baik — ada "Agent guidance" eksplisit (treat as hypotheses, decide TP/FP, start high-confidence, spawn subagents, stop & ask jika butuh keputusan arsitektur). Karena framing client sudah benar tapi tetap loop, **fix WAJIB di sisi router**, bukan mengandalkan prompt client yang lebih baik. Ini memperkuat keputusan: perbaikan di pipeline 9Router (RC-1/RC-3) + loop guard.

---

## 3. Prinsip Solusi (robust & dinamis, bukan hard counter)

Sesuai riset: **step counter = circuit breaker, bukan solusi**. Yang robust:
1. **Termination contract eksplisit** di system prompt (reward stopping, definisi "done").
2. **Beri model jalan keluar** saat `tool_choice:"required"` (exit tool) ATAU pakai `auto` setelah root cause garbage (RC-3/RC-4) diperbaiki.
3. **Action-repetition awareness** — deteksi tool call identik berulang dari conversation history, suntik sinyal anti-loop.
4. Semua **configurable per-model** (jangan hardcode khusus 1 model).

---

## 3b. Klasifikasi Fix: Root-Cause vs Safety-Net (anti band-aid)

> Prinsip: **utamakan memperbaiki AKAR, bukan menutupi gejala.** Tiap item diklasifikasi jujur agar tidak ada "fix yang cuma kelihatan fix".

| Item | Klasifikasi | Alasan |
|------|-------------|--------|
| Layer 0a — fix regex reasoning_content | **ROOT-CAUSE** | Memperbaiki bug nyata; mengembalikan perilaku yang memang dirancang. Bukan suppress. |
| Layer 1 — hapus `tool_choice:"required"` paksa | **ROOT-CAUSE** | `required` ITU SENDIRI hardcoded hack penyebab loop. Menghapusnya = hilangkan akar. |
| Layer 4 — config per-model | **ROOT-CAUSE (de-hardcode)** | Mengangkat hardcode jadi konfigurasi eksplisit. |
| Layer 0b — max_tokens default | **PERLU VERIFIKASI** | Hipotesis. Bisa jadi "asal override" jika client sebenarnya mengirim max_tokens. WAJIB cek dulu, jangan asal set. |
| Layer 2 — termination prompt | **LAST-RESORT** | Bertentangan dgn anjuran Moonshot (jangan over-specify). Hanya dipakai jika root fix terbukti tak cukup. |
| Layer 3 — loop guard | **SAFETY-NET** | Circuit breaker, bukan solusi (kata riset). Harus JARANG trigger jika root fix benar. |

### Validation Gate (mencegah penumpukan band-aid)
Implementasi WAJIB urut & ber-gate. **Dilarang menambah layer berikutnya sebelum membuktikan layer fundamental TIDAK cukup**, dengan bukti terukur:

1. Terapkan Layer 0a + Layer 1 (root-cause) → jalankan task react.doctor.
2. **GATE A**: Apakah loop hilang & ada jawaban final? Jika **YA → STOP. Selesai.** Layer 2 & 3 TIDAK diperlukan (jangan ditambah hanya untuk "berjaga").
3. Jika TIDAK: ukur & catat sisa masalah konkret (mis. masih garbage → cek RC-3/RC-4; masih loop di `auto` → baru pertimbangkan exit-tool).
4. **GATE B**: Hanya jika ada bukti spesifik root fix tak cukup, tambah Layer 2 (last-resort) — dan dokumentasikan ALASAN terukurnya di sini.
5. Layer 3 (safety-net) ditambah TERAKHIR sebagai jaring pengaman produksi, dengan metrik: jika ia trigger > X% request, berarti root fix gagal → kembali ke Gate A, jangan andalkan guard.

Output gate ini ditulis balik ke plan ini (kolom "bukti") saat eksekusi, supaya keputusan menambah layer selalu berbasis data, bukan asumsi.

---

## 4. Arsitektur Fix (berlapis, urut prioritas)

### Layer 0 — Perbaiki bug penyebab "garbage" + kontinuitas multi-turn (prasyarat utama)
- **Fix regex `reasoningContentInjector.js` secara ROBUST**: jangan sekadar tambah substring hardcoded. **Normalisasi model id dulu** (strip prefix provider `moonshotai/`) lalu match family, mis. ekstrak segmen terakhir path → match `/^kimi-k2/i` pada `kimi-k2.6`. Atau lebih baik: matcher berbasis "model family" yang dipakai konsisten di seluruh codebase. Tujuan: tahan terhadap varian `kimi-k2.7`, `provider-lain/kimi-k2.x`, dll — bukan tambal satu kasus.
- **`max_tokens` — VERIFIKASI DULU**: log request nyata dari Kiro/Claude Code. Apakah client benar tak kirim `max_tokens`? Jika kirim → JANGAN timpa (itu override asal). Hanya set default bila benar-benar absen, dan hormati nilai client bila ada.

Target: setelah Layer 0, mode `auto` tidak garbage DAN model "ingat" turn sebelumnya → tidak re-plan urutan identik.

### Layer 1 — Strategi `tool_choice` dinamis (inti, ROOT-CAUSE)
Hapus pemaksaan statis `required` (default.js:~325). Prinsip: **kembalikan kontrol natural ke model** — jangan menambah hack baru untuk menambal hack lama.
- Default: hormati `tool_choice` dari client (umumnya `auto`). Inilah perilaku benar — model boleh berhenti kapanpun.
- Hanya `required` bila client eksplisit memintanya.
- **Hipotesis utama**: setelah RC-3 (reasoning_content) diperbaiki, `auto` tidak lagi garbage → cukup hapus `required`, TANPA logika tambahan. Buktikan ini dulu di Gate A.

Alternatif (HANYA jika Gate A gagal & terbukti `auto` tetap loop): **Exit-tool injection** — saat `required`, suntik tool sintetis `task_done`; intercept → final message. Ini workaround sah (pola Cline/Roo) tapi tetap "override output", jadi last-resort, bukan default.

### Layer 2 — Termination-contract system prompt (LAST-RESORT, hanya jika Gate A gagal)
> Jangan diaktifkan secara default. Moonshot menganjurkan TIDAK over-specify di system prompt. Hanya pakai jika terbukti (Gate A/B) root fix tak cukup menghentikan loop.

Fungsi `injectTerminationPrompt(body, format, provider, model)` di `open-sse/rtk/terminationPrompt.js`, ikut pola `injectCaveman()`. Dipanggil di `chatCore.js` setelah `injectCaveman` (line ~131-134).

Isi prompt (minimal, additive, tidak menjelaskan tools):
- Reward stopping: "Jika informasi cukup, BERHENTI dan jawab. Jangan panggil tool kecuali perlu."
- Anti-repetition: "Jangan panggil tool dengan argumen sama dua kali."
- Single-pass verification (kriteria biner).

Risiko jujur: ini prompt-level nudge, bukan jaminan struktural. Jika ini "berhasil" tapi Layer 0/1 tidak, curigai root fix belum benar — jangan puas hanya karena gejala hilang.

### Layer 3 — Action-repetition detection (SAFETY-NET, ditambah TERAKHIR)
> Bukan root fix. Jaring pengaman produksi. Jika sering trigger → tanda root fix gagal, balik ke Gate A.

Util `open-sse/utils/loopGuard.js`:
- **Stateless**: analisis `translatedBody.messages` request saat ini. Hash tiap tool_call (`name + JSON.stringify(arguments-ternormalisasi)`). Dua mode:
  - **Single-call repeat**: hash sama ≥3x → loop.
  - **Sequence repeat (signature trace RC-5)**: N-gram urutan tool_call berulang ≥2x berturut.
- Aksi: **hanya inject hint** (non-destruktif, tidak hard-block/error). Worst case model abaikan → tak ada request gagal.
- **Metrik wajib**: hitung rate trigger. Target < beberapa % request. Jika tinggi → root fix (Layer 0/1) belum beres.
- Stateful (opsional): `Map` keyed `connectionId+model` + TTL (pola `sessionManager.js`) bila history dipangkas client.

### Layer 4 — Konfigurasi per-model
Tambah flag di `open-sse/config/providerModels.js` (pola `getModelStrip`):
- `injectTerminationPrompt: true`
- `dynamicToolChoice: true`
- `defaultMaxTokens: 64000`
Helper `getModelAgenticConfig(alias, modelId)`. Karena `moonshotai/kimi-k2.6` belum terdaftar di `PROVIDER_MODELS.nvidia`, perlu daftarkan entry-nya atau pakai matcher `includes("kimi-k2.6")` yang sudah ada di executor.

---

## 5. Lokasi Edit (ringkas)

| Layer | File | Lokasi | Aksi |
|-------|------|--------|------|
| 0 | `open-sse/utils/reasoningContentInjector.js` | rule Kimi (~line 14) | fix regex match `moonshotai/kimi-k2.6` |
| 0 | `open-sse/handlers/chatCore.js` atau `executors/default.js` | sebelum dispatch / `transformRequest` | set `max_tokens` default bila kosong |
| 1 | `open-sse/executors/default.js` | `~line 325` (force required) | jadikan dinamis / exit-tool |
| 2 | `open-sse/rtk/terminationPrompt.js` (BARU) | — | `injectTerminationPrompt()` ikut pola caveman |
| 2 | `open-sse/handlers/chatCore.js` | `~line 131-134` (setelah caveman) | panggil `injectTerminationPrompt` |
| 3 | `open-sse/utils/loopGuard.js` (BARU) | — | hash tool_calls dari history, deteksi repetisi |
| 4 | `open-sse/config/providerModels.js` | entry nvidia + helper | flag per-model + `getModelAgenticConfig` |

---

## 6. Strategi Try-n-Error (urutan eksperimen)

Karena fix melibatkan perilaku model (non-deterministik), implementasi harus iteratif. **Lokasi try-n-error = harness curl + unit test**, BUKAN tebak-tebakan di production.

### Tahap uji (pakai kredensial di `.kiro/steering/secrets.md`)

**Iterasi 0 — Baseline reproduksi**
- Curl langsung NVIDIA `moonshotai/kimi-k2.6` dengan tools (fetch) + `tool_choice:"required"`, prompt multi-step ("fetch URL A, lalu B, simpulkan").
- Konfirmasi: model tak pernah emit final answer (loop).

**Iterasi 1 — Layer 0 (regex + max_tokens)**
- Terapkan fix regex + max_tokens. Curl mode `tool_choice:"auto"`.
- Cek: apakah output masih garbage? Jika bersih → `auto` viable.
- **Validasi multi-turn (RC-5)**: kirim request dengan history berisi 2-3 assistant turn ber-tool_calls + tool_result; pastikan model melanjutkan (bukan re-fetch URL yang sudah ada di history). Verifikasi `reasoning_content` terinjeksi di SEMUA assistant turn (log `translatedBody.messages`).
- **Jika gagal** (masih garbage): cek `finish_reason`. Kalau `length` → naikkan max_tokens. Kalau bukan → cek apakah `reasoning_content` benar terinjeksi (log `translatedBody`).

**Iterasi 2 — Layer 1 (dynamic tool_choice)**
- Dengan `auto` (pasca Layer 0), jalankan task multi-step via 9Router lokal (`http://localhost:3003/v1`).
- Cek: model berhenti natural setelah cukup info?
- **Jika gagal** (masih loop di `auto`): aktifkan jalur **exit-tool injection** — suntik tool `task_done`, paksa `required`, intercept `task_done` → final message. Uji ulang.

**Iterasi 3 — Layer 2 (termination prompt)**
- Aktifkan `injectTerminationPrompt`. Ulang task react.doctor asli.
- Ukur: jumlah tool calls turun signifikan, ada jawaban final.
- **Jika gagal**: perketat wording prompt (reward stopping lebih eksplisit, contoh negatif). Iterasi wording di sini.

**Iterasi 4 — Layer 3 (loop guard)**
- Susun history sintetis: (a) 3+ tool_call identik, (b) **urutan/sequence identik berulang 2x** (signature trace RC-5). Verifikasi `loopGuard` mendeteksi keduanya & menyuntik anti-loop prompt; pastikan task multi-langkah sah (urutan beda) TIDAK false-positive.
- Uji end-to-end: task yang tadinya 191 calls harus konvergen < ~20 calls.

**Iterasi 5 — Layer 4 (config per-model)**
- Pindahkan trigger hardcode (`includes("kimi-k2.6")`) ke flag config. Aktif/nonaktifkan tiap layer via flag, jalankan ulang Iterasi 1-4 untuk pastikan tak ada regресi.
- Verifikasi model lain (non-Kimi) tidak terpengaruh (flag default off).

**Kriteria sukses akhir:**
- Task react.doctor "pahami detail" selesai dengan jawaban final, tanpa interrupt manual.
- Jumlah tool call wajar (puluhan, bukan ratusan), tidak ada fetch URL identik berulang ≥3x.
- Mode plain chat (tanpa tools) tetap normal (tidak ter-regресi).

---

## 7. Lokasi Unit Test (test berulang)

Direktori: `tests/unit/`. Runner: `cd tests && node_modules/.bin/vitest run`.

Existing: `tests/unit/kimi-nvidia-hardening.test.js` (19 test) — JANGAN diregресi.

### File test baru / tambahan:

**`tests/unit/termination-prompt.test.js`** (Layer 2)
- inject ke format openai → ada system message berisi instruksi terminasi.
- inject ke format claude → `body.system` terupdate benar.
- inject ke format gemini → `system_instruction.parts` terupdate.
- TIDAK menjelaskan nama tools (assert prompt tak menyebut tool spesifik).
- idempotent: panggil 2x tak menduplikasi.

**`tests/unit/loop-guard.test.js`** (Layer 3)
- 3 tool_call identik (name+args) di history → `detectLoop()` true.
- 2 tool_call identik → false (di bawah threshold).
- argumen beda → false.
- tool_call beda nama → false.
- history kosong / tanpa tool_calls → false (aman).
- hash stabil untuk argumen dengan urutan key berbeda (normalisasi).
- **sequence-repeat (signature trace RC-5)**: urutan `[fetch A, fetch B, fetch C, bash]` muncul 2x berturut → `detectLoop()` true.
- sequence muncul 1x → false; progress nyata (urutan beda tiap siklus) → false (tak false-positive untuk task multi-langkah sah).

**`tests/unit/dynamic-tool-choice.test.js`** (Layer 1)
- history tanpa tool_result → `auto`.
- client kirim `tool_choice:"none"` → dihormati (tak dipaksa).
- exit-tool injection: saat `required`, tool `task_done` ada di daftar tools.
- intercept `task_done` tool_call → response jadi final message `finish_reason:"stop"`.

**`tests/unit/reasoning-content-nvidia.test.js`** (Layer 0)
- `moonshotai/kimi-k2.6` → reasoning_content placeholder terinjeksi pada assistant ber-tool_calls (fix RC-3).
- `kimi-k2.5` (tanpa prefix) → tetap terinjeksi (tak regресi).
- model non-kimi → tak terinjeksi.
- **multi-turn (RC-5)**: history dengan beberapa assistant turn ber-tool_calls → SEMUA turn dapat reasoning_content (bukan hanya turn terakhir).

**`tests/unit/kimi-max-tokens.test.js`** (Layer 0)
- request Kimi NVIDIA tanpa `max_tokens` → ter-set ke `DEFAULT_MAX_TOKENS`.
- request dengan `max_tokens` eksplisit → tidak ditimpa.

**Regресi**: `kimi-nvidia-hardening.test.js` — sesuaikan test yang mengasumsikan `tool_choice` selalu `required` (sekarang dinamis). Tambah test: dynamic memilih `auto` di kondisi default.

### Pola test berulang (iteratif)
Setiap iterasi try-n-error di §6 dipasangkan dengan menjalankan:
```bash
cd tests && node_modules/.bin/vitest run unit/<file>.test.js
```
Loop: ubah kode → run unit test → kalau hijau, uji curl/integration → kalau perilaku model belum benar, refine → run unit test lagi. Unit test = guard agar refactor tak merusak logika deterministik (parsing, injeksi, deteksi); curl/integration = validasi perilaku model non-deterministik.

---

## 8. Urutan Eksekusi Implementasi (saat di-ACC)

1. Layer 0 (regex + max_tokens) + test → fondasi paling murah, hilangkan garbage.
2. Layer 1 (dynamic tool_choice) + test → buka jalan terminasi.
3. Layer 2 (termination prompt) + test → kontrak "done".
4. Layer 3 (loop guard) + test → jaring pengaman dinamis.
5. Layer 4 (config per-model) + test → generalisasi, lepas hardcode.
6. Integration test end-to-end task react.doctor via 9Router lokal.
7. Build + restart sesuai `agent.md`.

---

## 9. Risiko & Catatan
- Perubahan `tool_choice` default → bisa pengaruhi perilaku Kimi untuk request non-agentic. Mitigasi: gating ketat (hanya saat ada `tools` + provider nvidia + model kimi-k2.6), dan test regресi.
- Termination prompt terlalu agresif → model berhenti terlalu dini. Mitigasi: wording iteratif di Iterasi 3, ukur trade-off.
- Loop guard false-positive (task yang memang butuh banyak langkah serupa). Mitigasi: threshold ≥3 identik (bukan mirip), normalisasi argumen, hanya inject prompt (tidak hard-block).
- 9Router stateless: pendekatan stateless (analisis history per-request) lebih disukai daripada Map lintas-request untuk hindari kompleksitas & memory leak.

## 10. Rollback & Safety
- **Feature flag per-layer**: tiap layer (termination prompt, dynamic tool_choice, loop guard) di-gate flag config di `providerModels.js`/settings → bisa dimatikan tanpa redeploy kode bila ada regресi.
- **Default konservatif**: semua layer hanya aktif untuk `nvidia` + `kimi-k2.6`; model/provider lain tidak terpengaruh.
- **Rollback cepat**: tiap layer = commit terpisah (sesuai urutan §8) → `git revert` granular bila satu layer bermasalah.
- **Non-destruktif**: loop guard hanya MENYUNTIK prompt (tidak hard-block/error request) → worst case model abaikan hint, tidak ada request yang gagal karenanya.
- **Monitoring**: pakai `logGatewayError` (class STREAM/TOOL_CALL) + hitung tool-call per request di log untuk deteksi regресi loop pasca-deploy.

---

## 11. HASIL Gate A (eksekusi empiris) — VERDICT: root cause = 9Router menyuntik `max_tokens=64000`

Investigasi awal sempat menyimpulkan "upstream rusak" — itu **SALAH**. Bukti tandingan user (direct NVIDIA normal) memicu re-investigasi rigor. Hasil:

| Uji (multi-turn agentic, prompt sama) | Hasil |
|---|---|
| Direct NVIDIA, simple tool, `temp=0.6, max_tokens=1024` | ✅ tool_call bersih 3/3 |
| Via 9Router, `max_tokens=2048` | ✅ CONVERGED (WebFetch → summary) |
| Via 9Router, `max_tokens=8000` | ✅ CONVERGED |
| **Via 9Router & Direct, `max_tokens=64000`** | ❌ **LOOP / garbage (reproducible)** |

**Akar masalah:** `max_tokens=64000` membuat NVIDIA NIM kimi-k2.6 degenerasi (loop re-fetch / garbage / repetition). **9Router-lah yang menyuntik 64000** via "Layer 0b" (max_tokens default) — fix yang justru jadi BIANG masalah. Direct usage user normal karena pakai max_tokens wajar dan 9Router tak ikut campur.

Catatan: model tetap agak **flaky** untuk multi-turn agentic kompleks pada NVIDIA NIM (degenerasi non-deterministik pada sebagian prompt), tapi dengan max_tokens wajar JAUH lebih baik dan setara perilaku direct. 3 gejala lama (loop / garbage / silent-stop) semuanya manifestasi degenerasi yang dipicu/diperparah oleh max_tokens besar.

## 12. FIX FINAL yang diimplementasikan (robust, bukan band-aid)

**Clamp `max_tokens` ke ceiling aman (8192) untuk `nvidia/kimi-k2` — satu-satunya intervensi.**

- `executors/default.js`: jika client kirim `max_tokens > 8192` → clamp ke 8192. Nilai lebih kecil di-honor; tanpa max_tokens → tidak diinjeksi (biarkan default NVIDIA). TIDAK ada forced tool_choice, TIDAK ada block, TIDAK ada prompt injection. Response-side hardening (`isKimiToolFailure` → fail-fast repetition/garbage) tetap sebagai jaring → combo fallback.
- `reasoningContentInjector.js`: fix regex dipertahankan (RC-3) — reasoning_content terinjeksi benar untuk `moonshotai/kimi-k2.6`.
- `providerModels.js`: `AGENTIC_CONFIG.nvidia["kimi-k2"].maxTokensCeiling = 8192` (config-gated, de-hardcoded). Flag mati lain dibersihkan; `injectTerminationPrompt`/`loopGuard` tetap `false`.

Kenapa clamp (bukan passthrough murni / block): menyentuh TEPAT variabel penyebab (max_tokens besar) yang terbukti degenerasi, ~4 baris, tidak memblok model, melindungi dari client (mis. Kiro) yang mengirim max_tokens besar.

**Verifikasi empiris pasca-fix:**
- Unit: 64000→8192, 2048 di-honor, tak ada injeksi saat omit, non-Kimi tak terpengaruh. ✅
- E2E: client `max_tokens=64000` → outgoing di-clamp → **tool_call bersih** (bandingkan: 64000 tanpa clamp = garbage). ✅
- Multi-turn (max_tokens wajar) → CONVERGED. ✅
- 26 unit test kimi hijau.

**Layer 2 (termination prompt) & Layer 3 (loop guard) tetap NONAKTIF.**

**Rekomendasi operasional:**
- `nvidia/kimi-k2.6` bekerja untuk plain chat & tool call; 9Router otomatis melindungi dari max_tokens berlebih.
- Untuk agentic multi-turn yang sangat panjang, residual flakiness upstream masih mungkin → andalkan combo fallback ke model tool-capable (`kr/claude-sonnet-4.5`, Kimi via Moonshot resmi).

## 13. PELAJARAN (kejujuran proses)
Kesimpulan "upstream rusak" (§ versi awal) prematur — uji memakai `max_tokens=8000/64000` tanpa membandingkan apple-to-apple dengan usage direct user. Bukti user (direct normal) benar dan mengarahkan ke variabel sebenarnya: `max_tokens` besar yang DISUNTIK 9Router. Pelajaran: saat user punya bukti tandingan, reproduksi apple-to-apple (body identik, direct vs via-router) sebelum menyalahkan upstream.
