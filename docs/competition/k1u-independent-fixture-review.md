# K1-U independent golden-fixture review — UCWDC Majority Rules

Reviewer: independent side session (read-only). Date: 2026-10-24 (local).
Spec read: `origin/competition-k1-engine-specs` @ **a750e74f464e82ac81a753876efa8ee92e8c35c9** ("K1-U: remove leftover J<3 reference"), `docs/competition/engine-spec-ucwdc-majority-rules.md` (361 lines).
Independence: fixtures IR-01..IR-32 were designed and hand-computed from the source **before** reading the spec. `k1u-verification-report.md` was **not** read at any point. No repo file changed, no worktree, no install, no DB/Docker.

## Sources (sha256 verified 2026-10-24)

| File | sha256 | Match |
|---|---|---|
| 2026-Scoring-Format-v16.9b-1.pdf | 44290a06…667b02f | yes |
| 2026-UCWDC-Rules_Couples_v1-26-2026-1.pdf | 8a45ee58…8974904 | yes (registry on origin/main) |
| 2026-UCWDC-Rules_ProPro-ProAm_v1-26-2026.pdf | d6257b65…044e704db84 | yes |
| 2026-UCWDC-Rules_Line-Dance_V_1-26-2026-1.pdf | 98e90011…dc068b97fb7 | yes |
| 2026-UCWDC-Rules_Teams_V_1-26-2026-1.pdf | 7e71fdce…a7e2cdb41a | yes |

Extracted with `pdftotext -enc UTF-8 -layout`; ★ survives. The rule books contain no scoring calculation and no panel-size minimum (searched "number of judges", "minimum", "three/five judges", "panel").

Citations: R*n*.*p* = Scoring Format Rule #n part p.

## Verdict

**DISAGREEMENTS FOUND.** None of them is arithmetic. Every finals, tie-breaker and championship calculation in the spec gives the same result as my fixtures, and all 15 spec fixtures recompute identically. What I found:
- 3 places where the spec's rule would produce a different outcome from my fixture, or where the spec contradicts itself (D-1, D-2, D-3);
- 5 cases where the spec has no rule (D-4 to D-8);
- 3 defects in spec fixtures (D-9 to D-11).

Owner decisions: **all three are applied** (§4).

## 1. Reviewer fixtures (hand-computed)

Conventions: ProAm values per R3.2 (HM 26 … GG★ 11); Couples/AllStars/Spotlight per-judge ranks per R3.3; majority position m = (J+1)/2 for odd J, J/2+1 for even J (R3.4); "size" = count of sorted marks > majority mark (R4.1); "sum" = sum of positions 1..m−1 (R5.1); look-ahead = positions m+1..J (R6); look-behind = 1..m−1 (R7); head-to-head loss value = L + T/2 (R8.2). Callback points: Yes/No 10.0, Alt#1..#5 = 5.0, 4.6, 4.3, 4.1, 4.0 (R1.2, R2.2). Use tenths-integers to avoid float error.

### Callbacks (R1, R2)

**IR-01 Prelim Yes+Alt (R1.2, R1.4).** J=3, Yes count 2, Alt 2, designated N=3. J1: Yes 101,102; A1 103; A2 104. J2: Yes 101,103; A1 102; A2 105. J3: Yes 102,104; A1 101; A2 103.
101 = 10+10+5.0 = 25.0; 102 = 10+5.0+10 = 25.0; 103 = 5.0+10+4.6 = 19.6; 104 = 4.6+0+10 = 14.6; 105 = 4.6; 106 = 0.
Cut after 3rd: 19.6 vs 14.6, no tie. **Promoted {101,102,103}.** (The 0 for a judge who did not mark a contestant is READING R-A; see D-1.)

**IR-02 Prelim plus ties at the cut (R1.4).** J=3, Yes 1, Alt 2, N=3. J1: Yes 201; A1 202; A2 203. J2: Yes 201; A1 203; A2 202. J3: Yes 204; A1 205.
201 = 20.0; 204 = 10.0; 202 = 5.0+4.6 = 9.6; 203 = 4.6+5.0 = 9.6; 205 = 5.0.
3rd and 4th are tied at 9.6, so "plus ties" applies. **Promoted {201,204,202,203} (4); 205 retired.**

**IR-03 full Alt ladder (R1.2).** J=3, Yes 1, Alt 5, N=3. J1: Yes A; A1..A5 = B,C,D,E,F. J2: Yes A; A1..A5 = C,D,E,F,B. J3: Yes B; A1..A5 = D,E,F,C,A.
A = 10+10+4.0 = 24.0; B = 5.0+4.0+10 = 19.0; D = 4.3+4.6+5.0 = 13.9; C = 4.6+5.0+4.1 = 13.7; E = 4.1+4.3+4.6 = 13.0; F = 4.0+4.1+4.3 = 12.4. **Promoted {A,B,D}.** D beats C by 0.2, so the alt values must be exact.

**IR-04 Semi "No" only (R2.2, R2.4).** J=3, No 2, no alts, retire R=2. J1 No S5,S6; J2 No S5,S4; J3 No S6,S5. S5 = 30, S6 = 20, S4 = 10, S1–S3 = 0. Plain reading: "No" = "most wish to retire", so the highest No total is the least valued. **Retired {S5,S6}.** Classification: READING (the spec's G-6 reading is the same).

**IR-05 Semi No+Alt.** J=3, R=1. J1: No S6; A1 S5; A2 S4. J2: No S5; A1 S6; A2 S3. J3: No S6; A1 S4; A2 S5. S6 = 25.0; S5 = 19.6; S4 = 9.6; S3 = 4.6. Under the IR-04 reading, alternates accrue retire-points, so **S6 is retired**. Source status: the meaning of an alternate on a No ballot is not stated → **NOT SPECIFIED**. The arithmetic only fits "alternate No", but that is still a reading.

**IR-06 Semi tie at the retire cut.** J=3, R=1. J1 No S6; J2 No S5; J3 No S4 → all three = 10.0. R2.4 says the least valued "(plus ties, if any occur) are retired", which would retire 3. R2.3 says the Coordinator decides how many go to the Finals, "using the last callback values to fill the field of Finalists". **Expected: NOT SPECIFIED → fail closed** (see D-2).

### Finals marks and majority (R3)

**IR-07 ProAm J=5, 16-value (R3.2, R3.4, R3.5).**
P1 GG,GH★,GG+,GG,GH+ = [13,14,12,13,15] → [12,13,13,14,15], maj 13.
P2 G,GH,G★,GH,G+ = [19,16,17,16,18] → [16,16,17,18,19], maj 17.
P3 GG★,GG+,GG,GG★,GH★ = [11,12,13,11,14] → [11,11,12,13,14], maj 12.
P4 S,B★,S★,S+,G = [22,23,20,21,19] → [19..23], maj 21.
**P3 1st, P1 2nd, P2 3rd, P4 4th.**

**IR-08 ProAm J=3, judge ties, Rule 5 decides (R3.2, R4, R5).** Q1 HM,B,B+ = [26,25,24]; Q2 B,B,HM = [25,25,26] (J2 gave B to both Q1 and Q2, a judge tie); Q3 S,B★,B+ = [22,23,24]. m=2.
Q3 maj 23 → 1st. Q1 [24,25,26] maj 25; Q2 [25,25,26] maj 25 → tie.
R4: each has one mark > 25 (26) → tie. R5: Q1 24 < Q2 25. **Q3 1st, Q1 2nd, Q2 3rd.**

**IR-09 Couples Group-and-Rank J=3, Rule 4 decides (R3.3, R4).**
J1: C4 GH1, C1 G1, C2 G2, C3 S1, C5 B1 → ranks C4 1, C1 2, C2 3, C3 4, C5 5 (G2 beats S1).
J2: C1 GG1, C2 GH1, C3 GH2, C4 G1, C5 G2 → C1 1, C2 2, C3 3, C4 4, C5 5.
J3: C1 S1, C3 S2, C2 S3, C4 S4, C5 HM1 → C1 1, C3 2, C2 3, C4 4, C5 5.
C1 [2,1,1] → [1,1,2] maj 1. C2 [3,2,3] → [2,3,3] maj 3. C3 [4,3,2] → [2,3,4] maj 3. C4 [1,4,4] maj 4. C5 [5,5,5] maj 5.
C2 vs C3, R4: C2 has 0 marks > 3 (the 3 at position 3 is equal, so it does not count); C3 has 1 (the 4). **C1, C2, C3, C4, C5.**

**IR-10 ProAm AllStars, 6-medal Group-and-Rank, J=5 (R3.3 + owner OQ-2).**
J1 A1 GG1, A2 GG2, A3 GH1 → 1,2,3.
J2 A2 GG1, A1 GH1, A3 GH2 → A2 1, A1 2, A3 3.
J3 A3 GG1, A1 GG2, A2 GG3 → A3 1, A1 2, A2 3.
J4 A1 GH1, A3 GH2, A2 G1 → A1 1, A3 2, A2 3.
J5 A2 GH1, A3 GH2, A1 GH3 → A2 1, A3 2, A1 3.
A1 [1,2,2,1,3] → [1,1,2,2,3]; A2 [2,1,3,3,1] → [1,1,2,3,3]; A3 [3,3,1,2,2] → [1,2,2,3,3]. All maj 2.
R4 size: A1 1, A2 2, A3 2 → A1 1st. R5: A2 1+1 = 2 < A3 1+2 = 3. **A1, A2, A3.**

**IR-11 Spotlight duplicate medal-rank (R3.3 "Judges are not allowed to tie").** J1 gives S1 "G1" and S2 "G1". **Fail closed.**

**IR-12 J=7, maj = 4th, Rule 4 decides.** R1 [13,13,14,15,12,16,13] → [12,13,13,13,14,15,16] maj 13, size 3. R2 [12,12,12,19,19,19,14] → [12,12,12,14,19,19,19] maj 14. R3 [11,12,13,14,13,13,20] → [11,12,13,13,13,14,20] maj 13, size 2. **R3, R1, R2.**

**IR-13 J=4 emergency even, maj = 3rd ("one mark more than half", R3.4).** E1 [13,12,14,15] → [12,13,14,15] maj 14. E2 [16,12,12,13] → [12,12,13,16] maj 13. E3 [11,11,17,17] maj 17. **E2, E1, E3.** The wrong "J/2-th mark" reading would give the reverse order (E3 11, E2 12, E1 13), so this fixture tells the two apart.

**IR-14 J=6, maj = 4th.** X1 [11,11,11,20,20,20] maj 20. X2 [14,14,14,14,15,15] maj 14. X3 [12,12,13,15,16,16] maj 15. **X2, X3, X1.** A 3rd-mark reading would put X1 first.

**IR-15 J=3, Rule 6 decides.** T1 [12,13,14]; T2 [15,13,12] → [12,13,15]. Both maj 13, size 1, sum 12. Look-ahead [14] < [15]. **T1, T2.**

**IR-16 J=5, Rule 6 multi-column, 3-way.** U1 [11,12,13,14,16], U2 [11,12,13,15,15], U3 [11,12,13,14,15]: maj 13, size 2, sum 23 for all three. Look-ahead column 1: 14, 15, 14 → U2 last. Column 2 (U1 vs U3): 16 vs 15 → U3. **U3, U1, U2.** (A right-hand sum would give U1 = U2 = 30, so the column method decides differently.)

**IR-17 J=7, Rule 7 decides.** V1 [11,14,14,15,16,16,17], V2 [12,13,14,15,16,16,17]: maj 15; size 3 each; sum 39 each (11+14+14 and 12+13+14); look-ahead [16,16,17] equal. Look-behind column 1: 11 < 12. **V1, V2.**

### Rule #8 head-to-head

**IR-18 2-way (J=5).** Z [11×5] is 1st. W1 [13,14,12,15,13], W2 [14,13,15,13,12]; both sort to [12,13,13,14,15] (R8.1 proof holds). Per judge: J1 W1, J2 W2, J3 W1, J4 W2, J5 W2. W1 2-3-0 (loss 3), W2 3-2-0 (loss 2). **Z 1st, W2 2nd, W1 3rd.**

**IR-19 3-way with a re-visitation that reverses the order (J=5).** A [12,13,13,14,15], B [14,12,15,13,13], C [13,13,14,15,12] (identical multiset).
A vs B: A,B,A,B,B → A 2-3-0. A vs C: A,T,A,A,C → A 3-1-1. B vs C: C,B,C,B,C → B 2-3-0.
A 5-4-1 (loss 4.5); B 3-2-0 + 2-3-0 = 5-5-0 (5.0); C 1-3-1 + 3-2-0 = 4-5-1 (5.5). **A 1st.**
Re-visitation, B vs C only: B 2-3-0 (3), C 3-2-0 (2). **C 2nd, B 3rd.** Keeping the 3-way order would wrongly give B 2nd.

**IR-20 2-way final tie: announced placement and carry-forward (R8.4, R8.6).** Y0 [11,11,11] 1st; Y1 [13,14,13], Y2 [14,13,13]; Y3 [16,16,16]. Y1/Y2 are identical through Rule 7. Head-to-head: J1 Y1, J2 Y2, J3 tie → each 1-1-1 (loss 1.5) → final tie. **Y1 and Y2 announced "2nd", carry-forward (2+3)/2 = 2.5; Y3 announced "4th", carry-forward 4.**

**IR-21 3-way final tie in the middle of the field.** Z1 [11,11,11] 1st; Z2 [11,11,12] 2nd (maj 11, size 0 vs 1); K1 [12,13,14], K2 [13,14,12], K3 [14,12,13] (Latin square); Z6 [20,20,20]. Every pair splits 2-1, so each K is 3-3-0 (loss 3) → final tie. **K1–K3 announced "3rd", carry-forward (3+4+5)/3 = 4; Z6 announced "6th".**

**IR-22 shared best record with a remainder (R8.2/R8.3 gap).** A [12,13,13,14,15], B [12,13,14,15,13], C [13,13,15,12,14].
A vs B: T,T,A,A,B → A 2-1-2. A vs C: A,T,A,C,C → 2-2-1. B vs C: B,T,B,C,B → 3-1-1.
A 4-3-3 (4.5); B 1-2-2 + 3-1-1 = 4-3-3 (4.5); C 2-2-1 + 1-3-1 = 3-5-2 (6.0).
A and B have identical best records, but A beats B 2-1-2 head-to-head. The two readings differ: (a) A and B share 1st/2nd (carry-forward 1.5), C 3rd; (b) C 3rd, re-visit A vs B → A 1st, B 2nd. **Expected: NOT SPECIFIED → fail closed.**

### Championship (R9–R11)

**IR-23 plain aggregate, 5 dances (R9.2, R9.3).** N1 2+1+3.5+1+2 = 9.5; N2 1+3+1+2+4 = 11; N3 3+2+3.5+3+1 = 12.5 (N1 and N3 shared 3rd/4th in dance 3). **N1, N2, N3.**

**IR-24 weighted ascension (Showcase Masters: Waltz ×3, Two Step ×3, Solo Medley ×4, R9.2).** H1 (2,1,3) = 6+3+12 = 21; H2 (1,3,2) = 3+9+8 = 20; H3 (3,2,1) = 9+6+4 = 19. Unweighted, all three = 6. **H3, H2, H1.**

**IR-25 rounds-removed points (R9.1).** Each dance runs Prelims (2 rounds) → Semi → Final; finals sizes D1 6, D2 6, D3 5.
G1: D1 out in the Semi = 6+1 = 7; D2 2nd; D3 3rd → 12.
G2: D1 Semi 7; D2 out in the Prelims = 6+2 = 8 (READING R-B: both Prelims rounds feed the Semi, R1.2/R1.3); D3 5th → 20.
G3: D1 6th; D2 6th; D3 out in the Semi = 5+1 = 6 → 18.
**G1, G3, G2.** The order is unchanged if G2's Prelims value were 9. Duplicate values are not averaged (R9.1 "duplicated, thus tied").

**IR-26 Rule 10 decided by a non-formula dance (R10.1, R10.2).** Formula: Waltz, Two Step, Swing. L1 W1, T3, Sw3.5 = 7.5; L2 W3, T1, Sw3.5 = 7.5 (they shared 3rd/4th in Swing); both also danced Polka (not in the formula): L1 2nd, L2 5th.
Formula dances only: 1-1-1, which would wrongly go to Rule 11. With all common dances: W L1, T L2, Sw tie, Polka L1 → L1 2-1-1 (1.5), L2 1-2-1 (2.5). **L1 above L2.**

**IR-27 Rule 11, with the re-visitation back to Rule 10 (R11.2, R11.3).** Three dances, finals of 3, J=3, ProAm values.
D1: R1 [15,14,13] maj 14 size 1; R2 [14,12,11] maj 12; R3 [14,14,13] maj 14 size 0 → R2 1st, R3 2nd, R1 3rd.
D2: R1 [12,13,11] → [11,12,13]; R2 [15,12,11] → [11,12,15]; both maj 12, size 1, sum 11; R6 [13] < [15] → R1 1st, R2 2nd; R3 [16,14,14] maj 14 → 3rd.
D3: R3 [12,12,14] maj 12 1st; R1 [16,12,13] maj 13 2nd; R2 [13,14,15] maj 14 3rd.
R9: all = 6. R10 (placements): R1-R2 2-1, R1-R3 1-2, R2-R3 2-1 → each 3-3-0 → still tied.
R11 (judge marks, 9 per pair):
- R1 vs R2: D1 0-3-0, D2 1-1-1, D3 2-1-0 = 3-5-1.
- R1 vs R3: 0-1-2, 3-0-0, 1-1-1 = 4-2-3.
- R2 vs R3: 2-0-1, 3-0-0, 0-3-0 = 5-3-1.
- Totals: R1 7-7-4 (9); R2 5-3-1 + 5-3-1 = 10-6-2 (7); R3 2-4-3 + 3-5-1 = 5-9-4 (11).
**R2 1st.** Re-visitation goes **back to R10** for R1 vs R3: D1 R3, D2 R1, D3 R3 → **R3 2nd, R1 3rd.** Two wrong methods both give R1 2nd: re-running R11 for the pair (R1 4-2-3) and keeping the R11 3-way order.

### Fail-closed

| ID | Input | Expected |
|---|---|---|
| IR-28 | J=1 | fail closed, panel eligibility UNVERIFIED (owner OQ-3) |
| IR-29 | J=2 (the formula would give the 2nd mark) | fail closed, UNVERIFIED |
| IR-30 | ProAm J=3, contestant has marks from J1 and J2 only | fail closed (no missing-mark rule anywhere in the source) |
| IR-31 | ProAm mark 27, "HM+" (R3.1: no tier on HM), "GG★★"; AllStars "GH+"; Couples "G+" | fail closed (outside the scale) |
| IR-32 | Callback: set Yes = 2 but J2's ballot has 1 Yes; or a judge's ballot is missing | fail closed (R1.2 "a set number"; no rule for short or missing ballots) |

All 32 fixtures were also run through a throwaway cross-check script (scratchpad/tools/mr.js). Script and hand results agree.

## 2. Spec comparison (spec @ a750e74f)

| Fixture | Spec rule | Spec result | Agree? |
|---|---|---|---|
| IR-01 | §3.2 G-1 sum; G-2 unmarked value NOT SPECIFIED, "fails closed … in a way that changes the outcome" | not determinable (see D-1) | **D-1** |
| IR-02 | §3.2 plus ties (G-3) | 4 promoted (if G-2 passes) | yes, subject to D-1 |
| IR-03 | §3.2 values | {A,B,D} | yes, subject to D-1 |
| IR-04 | §3.3 G-6 | retire {S5,S6}, but §3.3 G-5 says "does not run a Semi-Finals calculation" | **D-3(b)** ambiguous scope |
| IR-05 | G-5 fail closed | fail closed | yes (spec is more conservative than my reading) |
| IR-06 | §3.3 "least valued (plus ties) are retired" | retires all 3 tied | **D-2** |
| IR-07 | §4.2, §5 | same | yes |
| IR-08 | §4.2 ties allowed, R5 | same | yes |
| IR-09 | §4.3 G-8 dense rank, R4 strict | same | yes |
| IR-10 | §4.3 OQ-2 | same | yes |
| IR-11 | §4.3 "Judges cannot tie", F-U-15(a2) | fail closed | yes (explicit only for AllStars/Spotlight, see D-7) |
| IR-12..IR-17 | §5 m = floor(J/2)+1, §6 table | same | yes |
| IR-18..IR-21 | §6.2 | same | yes |
| IR-22 | §6.2 G-13 bullet 2 | fail closed | yes (IR-22 is a concrete, constructible input for G-13) |
| IR-23, IR-24 | §8.1 | same | yes |
| IR-25 | §8.1 | 7 for G1 and G3 OK; how "rounds removed" is counted with 2 Prelims rounds is not defined, nor whether it is an input | **D-4** |
| IR-26 | §8.2 R10 incl. non-formula dances | same, **but** §11 fails closed on every NOT SPECIFIED item and G-15(a) is NOT SPECIFIED | **D-3** |
| IR-27 | §8.2 R11 back to R10 | same | yes |
| IR-28, IR-29 | §5 G-10 | fail closed | yes |
| IR-30 | G-21 | fail closed | yes |
| IR-31 | §4.4, F-U-15(a)/(a2), §4.3 | fail closed | yes |
| IR-32 | G-4 covers duplicates only | no rule for a wrong Yes count or a missing ballot | **D-5** |

## 3. Spec fixture recomputation

| Fixture | My recomputation | Agree |
|---|---|---|
| F-U-01 | scale 26..11 matches R3.2 lines (UTF-8 ★ present) | yes |
| F-U-02 | 5→3, 7→4, 9→5, 11→6, 6→4, 8→5, 10→6; examples give 13 and 3 | yes |
| F-U-03 | all 4 rows (size 2/1/0/2, sum 23/24/26/25, ahead/behind) | yes |
| F-U-04 | A,B maj 19, size 1, sum 35; R6 col 2: 20 < 22 → B, A, C, D | yes |
| F-U-05 | sum 24/24, behind 11 < 12 → X, Y | yes |
| F-U-06 | ranks A[1,2,2] B[2,1,3] C[3,3,1]; R4 0 vs 1 → A, B, C | yes |
| F-U-07 | P 2-3-1 (3.5), Q 2-2-2 (3), R 3-2-1 (2.5); R 1st; P/Q 1-1-1 → share, carry-forward 2.5 | yes |
| F-U-08 | all 3-3-0 → share 1st, carry-forward 2 | yes |
| F-U-09 | 1-1-1 each → "1st" both, 1.5, next "3rd" | yes |
| F-U-10 | maj 14, size 2, sum 36 | yes |
| F-U-11 | A=B=C=25.0, D 9.2, E 4.6; N=3 and N=2 both → A,B,C | yes (note D-10) |
| F-U-12 | X 6, Y 6, Z 7, W 11; R10 X 2-1 → X, Y, Z, W | yes |
| F-U-13 | 21 | yes |
| F-U-14 | 7, 8, 9 | yes (structure caveat D-4) |
| F-U-15 | (a)(a2)(a3)(b)(c)(e)(f) consistent | (d) and (g) are defective as fixtures: D-9, D-11 |

## 4. Owner decisions (2026-10-25), checked at a750e74f

| Decision | Applied? | Where |
|---|---|---|
| 16-mark ProAm/ProPro scale HM=26..GG★=11 supersedes the rule-book lists | **yes** | §4.2, §4.4 (rule-book lists quoted correctly: M,B,S,S+,G,G+,GH,GH+,GG, checked against all four books), G-9 RESOLVED, F-U-01, F-U-15(a) |
| ProAm AllStars, ProAm/ProPro Spotlight on 6-medal Group-and-Rank | **yes** | §4.3 bullets + ballot-format mapping, G-20 RESOLVED, F-U-15(a2) |
| Panel eligibility UNVERIFIED, J=1/2 fail closed, no J≥3 guard, majority exact for odd/even | **yes** | §5, G-10, §11, F-U-15(b), OQ-3; a grep for "J ≥ 3"/"J<3" finds only the "no J ≥ 3 guard" statements |

Not yet applied or still open: the 11 March 2026 newsletter is not pinned (sha256 pending, as the spec itself says). §5 leaves open whether `panel_eligibility = UNVERIFIED` blocks J ≥ 3 ("a policy for the owner"). This is consistent with the decision but is an open owner item.

## 5. Discrepancies

**D-1 (HIGH): the unmarked-callback rule cannot be operated.** Spec §3.2 G-2 says the engine "fails closed for any contestant a judge left unmarked in a way that changes the outcome". Source: R1.2 "a 'Yes' for a set number of contestants … Totaling the points across this scale" (likewise R2.2). On every normal callback ballot most contestants are unmarked by most judges, because a judge marks only N Yes plus ≤5 Alt. "Changes the outcome" cannot be evaluated without an assumed range for the unknown value, and the spec gives none. So either every callback round fails closed, or the engine invents a bound. Reviewer view: zero is implied by "totaling the points across this scale" (no scale value means no points), but it is not stated. **Needs an explicit owner decision (zero vs fail closed). The conditional wording should not stand.** It affects IR-01..03 and F-U-11 (whose note only addresses F; D and E are also partly unmarked).

**D-2 (MEDIUM): a tie at the Semi-Finals retire cut.** The spec retires everyone tied ("least valued (plus ties) are retired", §3.3, citing R2.4). R2.3 says "the Contest Coordinator will determine the number of contestants who move on to the Finals, using the last callback values to fill the field of Finalists until the appropriate number … is reached." The two do not say the same thing about who is retired when contestants tie at the cut. IR-06 retires 3 of 6 under the spec. Reviewer: NOT SPECIFIED → fail closed, or an owner decision.

**D-3 (MEDIUM): the spec contradicts itself on the Rule 10 "placement" (G-15 bullet 1) and the scope of G-5.**
(a) §11 says fail closed "on every item marked NOT SPECIFIED". G-15(a) (announced placement vs carry-forward value) is marked NOT SPECIFIED, yet F-U-12 and the R10 rule expect a result. The ambiguity is in fact **provably immaterial** for Rule 10. Rule 10 only compares two contestants' values within one dance. Both encodings are monotone in finishing order and equal within a final-tie group. Rounds-removed values (F+k) are above every finalist and equal at equal k. So win/loss/tie is identical under either reading. Recommend recording that proof and removing the fail-closed status, rather than leaving an item that §11 would block.
(b) §3.3 G-5 says "The engine does not run a Semi-Finals calculation until … resolved", which reads as all Semi-Finals. F-U-15(e) limits it to "a Semi-Finals ballot containing alternates". Which is meant for a No-only ballot (IR-04)?

**D-4 (MEDIUM): counting "rounds removed" (R9.1) is not defined for the structure the source requires.** Semi-Finals exist only when ≥2 Prelims rounds were used (R2 heading, R2.2 last sentence). Prelims round 2 is for those not promoted from round 1 (R1.3). Both feed the Semi (R1.2 "all who are promoted will next dance in a Semi-Finals Round"). The spec does not say whether a Prelims-round-2 retiree is 2 or 3 rounds removed, nor whether "rounds removed" is an engine input or derived. IR-25 uses READING R-B (2 rounds). Recommend: make it an explicit input with a recorded reading, or fail closed.

**D-5 (LOW–MEDIUM): callback ballot validity is incomplete.** G-4 rejects duplicate or overlapping marks only. There is no rule for a ballot with fewer or more Yes than the set number (R1.2 / R2.2 "a set number"), Alt ranks with gaps (Alt#2 without Alt#1), or a missing judge ballot (IR-32). Spec §11 "inputs outside the rules" may be intended to cover these, but it does not list them.

**D-6 (LOW–MEDIUM): Rule 10/11 dances where a tied contestant did not reach the Finals.** G-15 bullet 2 raises this for Rule 11 only. For Rule 10, whether a dance counts as "commonly competed-in … mutually danced against each other for placements" (R10.1) when one or both tied contestants have only a rounds-removed points value is also not stated. The spec silently includes it. Also not covered: an empty commonly-competed-in set (fail closed?).

**D-7 (LOW): Group-and-Rank ballot validity for Couples/Line/Teams.** R3.3 "ranked by the judge from first ('1'), second ('2'), etc., to last" and "not allowed to tie". The spec says judges cannot tie, but its only fail-closed fixture is for AllStars/Spotlight (F-U-15(a2)). There is no rule for a duplicate rank in Couples, or for non-contiguous ranks (G1, G3 with no G2, or ranks starting at 2). G-8's dense conversion would silently accept those.

**D-8 (LOW): Rule 8/10/11 when the best record is shared (G-13).** This is a confirmation, not a disagreement. IR-22 is a constructible input from valid marks in which the two readings give different results (A,B sharing 1st/2nd at 1.5 vs A 1st/B 2nd). Recommend adding it as a concrete spec fixture for G-13 bullet 2. G-13 bullet 1 (equal loss value, different records) needs ≥3 tied (see D-9).

**D-9 (LOW, spec fixture defect): F-U-15(d) cannot be constructed as written.** With exactly two tied contestants, the records are mirror images (A W-L-T ↔ B L-W-T), so equal loss value ⇔ identical records. "Two contestants with … records 13-9-0 and 11-7-4" is impossible in a 2-way tie. It needs ≥3 tied contestants (22 games each, e.g. 3 tied with J=11) and concrete inputs.

**D-10 (LOW): F-U-11 note.** It says only F is unmarked. D (unmarked by J2) and E (by J1, J3) are also unmarked by some judges. The outcome is unaffected for any unmarked value ≤ 4.0, but under D-1 as written the engine would have to decide this.

**D-11 (LOW, spec fixture defect): F-U-15(g) cannot be reached from any input.** Equal majority mark (R3) + equal look-ahead vector (R6) + equal look-behind vector (R7) implies identical sorted marks. So "tied after Rule 7 with different re-ordered marks" can only come from an implementation bug. Keep it as an internal assertion, not an input fixture.

Source notes (agree with the spec): G-12 (R6.1/R7.1 dropped-digit sums "3"/"4") and G-16 ("Rule #10, part #4" does not exist; part #2 is meant) are confirmed independently.

## 6. Open questions (for the owner or coordinator)

1. D-1: is the callback value of an unmarked contestant zero (owner decision), or does every callback round fail closed?
2. D-2: Semi-Finals tie at the retire cut: retire all tied (R2.4 literal) or Coordinator decides (R2.3)?
3. D-4: rounds-removed counting with two Prelims rounds; is it an input?
4. G-13 / IR-22: shared best record with a remainder: final shared tie, or re-visit within the shared group? (The fail-closed default is fine until decided.)
5. OQ-3 follow-up: does `panel_eligibility = UNVERIFIED` block J ≥ 3 at launch? The source request for an official panel-size document is still open.
6. D-6: Rule 10/11 treatment of dances where a tied contestant was not a finalist; an empty common set.
7. Is the threshold title (REP, G-18) needed for launch? It stays NOT SPECIFIED; no derivation was invented.
