# Convenience targets for the BioVoice repo.
# Backend uses its local venv (backend/.venv, per README quick start).

.PHONY: test test-slow reports

# Fast suite: backend (excludes slow real-model tests) + frontend unit tests.
test:
	cd backend && .venv/bin/pytest -q -m "not slow"
	cd frontend && npm run test

# Slow suite: real ReDimNet + AASIST weights + trained-heads training test.
test-slow:
	cd backend && .venv/bin/pytest -q -m slow

# Validation reports -> /reports (local-only: needs the [bench] extra +
# datasets + system TTS). Pass dataset paths as variables, e.g.:
#   make reports SPOOF_EVAL=/tmp/spoof_eval
#   make reports VOX_PAIRS=pairs.txt VOX_AUDIO=/data/voxceleb1
reports:
	cd backend && .venv/bin/python scripts/make_validation_reports.py --out ../reports \
		$(if $(SPOOF_EVAL),--spoof-eval $(SPOOF_EVAL),) \
		$(if $(VOX_PAIRS),--voxceleb-pairs $(VOX_PAIRS),) \
		$(if $(VOX_AUDIO),--voxceleb-audio-root $(VOX_AUDIO),)
