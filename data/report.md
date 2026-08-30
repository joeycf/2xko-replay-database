# 2XKO replay parse report

_Generated 2026-08-30T12:00:11.123Z._

## Summary
- Total videos: **6542**
- High confidence: **6515**  ·  Low confidence: **17**  ·  Manual (hand-authored): **10**
- Newly discovered players (auto-added to `players.json`): **1**
- Fill rates — season: **95.4%** · patchVersion: **95.2%** · patch label: **15.5%** · fuse: **99.9%**
- Season derivation (date-authoritative) — boundary-graced: **6** · stale description labels overridden: **629**

## Records by source

| source | records | mode |
|---|---|---|
| `bestReplays` | 2480 | fetched |
| `highLevel` | 1826 | fetched |
| `proReplays` | 1317 | carried (frozen) |
| `replayTheater` | 888 | carried (local-first, no dump this run) |
| `evoEvents` | 21 | fetched |
| `manual` | 10 | hand-authored |
| **Σ** | **6542** | |

## Frozen channels (1)
_Not fetched. Their committed records are carried forward and still receive fuse detections and `overrides.json` verdicts. Pruning one requires editing `frozen.records` in `scripts/channels.ts`._

| channel | carried | frozen since | reason |
|---|---|---|---|
| `proReplays` | 1317 | 2026-08-08 | channel rebranded to MARVEL TOKON and unlisted its 2XKO catalogue |

## Local-first sources (1)
_Deliberately outside the daily cron: a third party's uptime is not a cron dependency. Refreshed by hand, and carried from the committed catalogue on every run without a dump — which is every cron run._

**Guard posture, stated rather than assumed.** The channel-collapse guard is ASLEEP for these on a carrying run: it compares raw/ against the catalogue, and there is no raw/ to compare. The count pin in `data/source-pins.json` is what is awake, and it is strictly stronger — it demands an exact number where the collapse guard only demands "not much smaller".

| source | records | pin now | this run | newest record |
|---|---|---|---|---|
| `replayTheater` | 888 | 888 | carried (no dump) | 2026-07-31 |

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

## Low-confidence records (17)
| id | channel | reason | raw title |
|---|---|---|---|
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
| `KtljpBCtoko@4191` | replayTheater | carried from a local-first source — original parse reasons not retained | 2XKO ▰ Vincentdabaddie (Juggernaut Illaoi) vs Dragoon (Yasuo / Ahri) ▰ ParagOnline #1 |

## Newly discovered players (1)
_Auto-added to `data/players.json` with a best-guess `displayName`. Fix casing / add aliases as needed._

| slug | displayName | occurrences | aliases seen |
|---|---|---|---|
| `wahibo2mars` | WAHIBO2MARS | 1 | wahibo2mars |
