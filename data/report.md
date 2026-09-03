# 2XKO replay parse report

_Generated 2026-09-03T01:54:19.018Z._

## Summary
- Total videos: **6564**
- High confidence: **6536**  ·  Low confidence: **18**  ·  Manual (hand-authored): **10**
- Newly discovered players (auto-added to `players.json`): **0**
- Fill rates — season: **95.4%** · patchVersion: **95.2%** · patch label: **15.7%** · fuse: **100.0%**
- Season derivation (date-authoritative) — boundary-graced: **6** · stale description labels overridden: **636**

## Records by source

| source | records | mode |
|---|---|---|
| `bestReplays` | 2495 | fetched |
| `highLevel` | 1833 | fetched |
| `proReplays` | 1317 | carried (frozen) |
| `replayTheater` | 888 | carried (pull found no new tournament entries) |
| `evoEvents` | 21 | fetched |
| `manual` | 10 | hand-authored |
| **Σ** | **6564** | |

## Frozen channels (1)
_Not fetched. Their committed records are carried forward and still receive fuse detections and `overrides.json` verdicts. Pruning one requires editing `frozen.records` in `scripts/channels.ts`._

| channel | carried | frozen since | reason |
|---|---|---|---|
| `proReplays` | 1317 | 2026-08-08 | channel rebranded to MARVEL TOKON and unlisted its 2XKO catalogue |

## Index intakes (1)
_Fetched by the daily cron since 2026-09-02, and **add-only**: a committed record is carried whether or not the catalogue still lists it, so this count can only rise. The cron does not depend on the pull succeeding — on any failure there is no dump, the committed records are carried, and the run stays green._

**Guard posture, stated rather than assumed.** The channel-collapse guard is ASLEEP for these: its dump is a cursor DELTA, so comparing it against the committed catalogue would fire every morning. What is awake instead is the add-only merge, which makes the published count non-decreasing by construction, and the pin in `data/source-pins.json`, which now refuses to move DOWNWARD without `--allow-shrink`.

| source | records | pin now | this run | pages | new | not in this pull | newest record |
|---|---|---|---|---|---|---|---|
| `replayTheater` | 888 | 888 | carried (pull found nothing tagged) | — | — | — | 2026-07-31 |

_The pull ran and found no new tournament entries, so the committed catalogue was carried unchanged. The cursor still advanced — a quiet day is the ordinary case here, not a failed one._

## Replay Theater cross-check

An independent reading of **2433** of our own records, from the catalogue's
UNTAGGED entries — online replays it indexes that we also parse from a tracked
channel. Neither side saw the other, so this is the only accuracy number here the
pipeline did not produce about itself. It changes nothing: a disagreement is
recorded in `data/theater-disagreements.json` with both claims, never written into
a record. The catalogue does not outrank a confident parse and never outranks a
human override.

_Measured on the last full sweep, at catalogue entry 488405. 300 distinct video(s)_
_the catalogue links are ones we do not hold; 0 are VODs it segments, which the_
_intake owns; 0 point at a record of ours with no two sides to align._

| field | population | agree | partial | disagree | cannot witness |
|---|---|---|---|---|---|
| players (both handles) | 2433 | 2423 (99.59%) | 10 | 0 | — |
| champions (per side) | 4866 | 4860 (99.88%) | 0 | 6 (0.12%) | 0 |

Side order differed on **2** record(s); the comparison realigns on the
handles before reading champions, so a swapped pair is not counted twice as a
champion disagreement.

**Cannot witness** is not disagreement: the index caps a 2XKO side at two champions
and cannot express a within-set counter-pick, and a champion string its vocabulary
spells differently from ours resolves to nothing. Neither is the catalogue
contradicting us — it is the catalogue being unable to say what we said.

**6 disagreement(s)** — both claims, ours first:

- `mvKlmuoEJ8c` side 1 characters: **thresh, caitlyn** vs catalogue **blitzcrank, vi** — 2XKO ▰ Panunu (Braum / Blitzcrank) vs Romerulez + C. Embers (Thresh / 
- `TPGD4QiJOa0` side 1 characters: **akali, vi** vs catalogue **yasuo, vi** — 2XKO ▰ SoulDemonXL (Thresh / Ekko) vs DizzyMX (Akali / Vi) ▰ High Leve
- `AdQJJn0O17M` side 1 characters: **vi, ahri** vs catalogue **teemo, ahri** — 2XKO ▰ Bleed (Illaoi / Ekko) vs Hikari (Vi / Ahri) ▰ High Level Gamepl
- `aFWFnakjcMM` side 0 characters: **teemo, darius** vs catalogue **yasuo, teemo** — 2XKO ▰ GENISGOD (Teemo-Darius) vs MRZEIM (Caitlyn-Vi) ▰ 2XKO Pro level
- `VjA1VOogCog` side 1 characters: **(none)** vs catalogue **braum, blitzcrank** — 2XKO ▰ INTERESTINGLAMP (Darius-Yasuo) vs PANUNU (pj1-pj2) ▰ 2XKO Pro l
- `8_JJkHTB-UA` side 0 characters: **(none)** vs catalogue **yasuo, darius** — 2XKO ▰ K7 SHOWOFF (pj1-pj2) vs SENSHI (Ekko-Illaoi) ▰ 2XKO Pro level r

## Manual videos (10)
_Hand-authored in `data/manual-videos.json` — never parse failures. Entries with an open `todo` need data filled in._

| id | tournament | round | todo |
|---|---|---|---|
| `z4g0nXVPy6k` | Frosty Faustings 2026 | Winners Semifinal |  |
| `yZ51w-wbW8s` | Frosty Faustings 2026 | Winners Semifinal |  |
| `4FypBAwMOV4` | Frosty Faustings 2026 | Losers Round 1 |  |
| `qAEoWt1dCaY` | Frosty Faustings 2026 | Losers Round 1 |  |
| `fniPaEENBhA` | Frosty Faustings 2026 | Losers Quarterfinal |  |
| `K7cdRBwsc98` | Frosty Faustings 2026 | Losers Quarterfinal |  |
| `h_z-gXJWlu8` | Frosty Faustings 2026 | Losers Semifinal |  |
| `c_QvODVM0pw` | Frosty Faustings 2026 | Winners Final |  |
| `d075s3HPm_0` | Frosty Faustings 2026 | Losers Final |  |
| `bSJgmmHctq8` | Frosty Faustings 2026 | Grand Final |  |

## Low-confidence records (18)
| id | channel | reason | raw title |
|---|---|---|---|
| `KGURPriuuoE` | highLevel | team left: 1 character(s) (expected 2) | 2XKO ▰ D.Dinosaur ( Warwick ) vs pMoney+pMoneyjr (Thresh / Blitzcrank) ▰ High Level Gameplay |
| `Ezt0FRx73f4` | highLevel | team left: 1 character(s) (expected 2) | 2XKO ▰ Dapper dinosaur ( Warwick ) vs Romerulez (Warwick / Thresh) ▰ High Level Gameplay |
| `BwYfw_m17Hk` | highLevel | team left: 1 character(s) (expected 2) | 2XKO ▰ Dapper dinosaur ( Warwick ) vs Lumen (Akali / Yasuo) ▰ High Level Gameplay |
| `p23gtPNc5d0` | highLevel | team left: 1 character(s) (expected 2) | 2XKO ▰ Syrtic ( Blitzcrank ) vs Dapper Dinosaur + Sylvanos (Warwick / Vi) ▰ High Level Gameplay |
| `_KOJhaYSmC8` | highLevel | team left: 1 character(s) (expected 2); team right: 1 character(s) (expected 2) | 2XKO ▰ Galladiated ( Darius ) vs BrandonThe4sian ( Darius ) ▰ High Level Gameplay |
| `5ehHxiFOESc` | highLevel | team left: 1 character(s) (expected 2) | 2XKO ▰ Wawa (Yasuo) vs Slauw (Jinx / Blitzcrank) ▰ High Level Gameplay |
| `3-_bNAYEAfo` | bestReplays | structural failure (team-split) | 2XKO ▰ AKAONI & VLAD vs HIKI (Jinx-Ekko) ▰ 2XKO Pro Replays |
| `OXAeNs7Ocg8` | proReplays | carried from a frozen channel — original parse reasons not retained | 2XKO ▰ SENDO (Akalai-Ahri) vs BLEED (Ekko-Illaoi) ▰ 2XKO Pro level replays |
| `Gy1V3_ctj3Q` | proReplays | carried from a frozen channel — original parse reasons not retained | 2XKO ▰ RONNICHU (Thresh-Ahri) vs SOULDEMONXL (Akalai-Ahri) ▰ 2XKO Pro level replays |
| `aY-ffoGazlY` | proReplays | carried from a frozen channel — original parse reasons not retained | 2XKO ▰ K7 SHOWOFF (Thresh-Yasuo) vs EDGERUNNER (Akalai-Ekko) ▰ 2XKO Pro level replays |
| `z_g1JJjLn7g` | proReplays | carried from a frozen channel — original parse reasons not retained | 2XKO ▰ SUPERNOON (Teemo-Ekko) vs HUEBERT (Akalai-Ekko) ▰ 2XKO Pro level replays |
| `SVGjJmhAGRQ` | proReplays | carried from a frozen channel — original parse reasons not retained | 2XKO ▰ PINKPINK (Akali-Ahri) vs CLOUD805 (Akali-Ysuo) ▰ 2XKO Pro level replays |
| `WeXMoFuuG_g` | proReplays | carried from a frozen channel — original parse reasons not retained | 2XKO ▰ INZEM-SONICFOX (Teeo-Ahri) vs SEMIIJ (Vi-Ahri) ▰ 2XKO Pro level replays |
| `hrTe0L43dlY` | proReplays | carried from a frozen channel — original parse reasons not retained | 2XKO ▰ GENISGOD (Yasuo-Teemo) vs L1NZ (Warwixk-Caitlyn) ▰ 2XKO Pro level replays |
| `VjA1VOogCog` | proReplays | carried from a frozen channel — original parse reasons not retained | 2XKO ▰ INTERESTINGLAMP (Darius-Yasuo) vs PANUNU (pj1-pj2) ▰ 2XKO Pro level replays |
| `8_JJkHTB-UA` | proReplays | carried from a frozen channel — original parse reasons not retained | 2XKO ▰ K7 SHOWOFF (pj1-pj2) vs SENSHI (Ekko-Illaoi) ▰ 2XKO Pro level replays |
| `VklFg7dEoSQ` | proReplays | carried from a frozen channel — original parse reasons not retained | Justin Wong (Blitzcranck-Vi) vs Mega20xx (Ekko-Vi) ▰ 2XKO Pro level replays |
| `KtljpBCtoko@4191` | replayTheater | carried from the index source — original parse reasons not retained | 2XKO ▰ Vincentdabaddie (Juggernaut Illaoi) vs Dragoon (Yasuo / Ahri) ▰ ParagOnline #1 |

## Newly discovered players (0)
_Auto-added to `data/players.json` with a best-guess `displayName`. Fix casing / add aliases as needed._

_None._
