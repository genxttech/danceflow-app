# Sourced by run_cf1_od17.sh and test_run_cf1_od17_classification.sh.
# r2na <suite>: 0 (NOT APPLICABLE) only for the R2-required suites rb3 / rb3r / RB3R and only when the expected-mode precheck proved the chain legitimately has no R2
# (EXPMODE=absent AND CATLEDGER=f AND CODEMODE=absent). Anything else (R2 required, inconsistent state, any other suite) returns 1 and keeps its real verdict.
r2na() { [ "$EXPMODE" = absent ] && [ "$CATLEDGER" = f ] && [ "$CODEMODE" = absent ] && case " $1 " in " rb3 "|" rb3r "|" RB3R ") return 0;; esac; return 1; }
