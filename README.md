# BioVoice App

Local development setup for the BioVoice web app.

## Project structure

- `backend`: FastAPI API server
- `frontend`: Vite + React client
- `XTTS-v2`: local XTTS model directory used for spoof generation

## Backend

The backend expects Python `3.11`.

From the repo root:

```powershell
C:\Users\yoav1\AppData\Local\Programs\Python\Python311\python.exe -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install wheel setuptools
.\.venv\Scripts\python.exe -m pip install fastapi "uvicorn[standard]" pydantic python-multipart numpy scipy torch torchaudio
```

Run the backend:

```powershell
cd backend
..\ .venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Use this exact command without the space in the interpreter path:

```powershell
..\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Backend URLs:

- API: `http://127.0.0.1:8000`
- Swagger UI: `http://127.0.0.1:8000/docs`

## Frontend

The frontend uses Vite and reads `VITE_API_BASE_URL` from `frontend/.env`.

From the repo root:

```powershell
cd frontend
npm install
npm run dev
```

Frontend URL:

- App: `http://localhost:5173`

The default API base URL is already set to:

```text
http://localhost:8000
```

## Run everything

Use two terminals.

Terminal 1:

```powershell
cd C:\Users\yoav1\final\BioVoice-App\backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Terminal 2:

```powershell
cd C:\Users\yoav1\final\BioVoice-App\frontend
npm run dev
```

Then open `http://localhost:5173`.

## Notes

- If the backend fails with compiled-package import errors, recreate `.venv` with Python `3.11`.
- The spoof-generation path depends on XTTS-related packages and the local `XTTS-v2` directory.
