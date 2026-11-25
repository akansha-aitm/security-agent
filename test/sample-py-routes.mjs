// Planted Python endpoints for the endpoint checks: Flask, FastAPI, a Teams bot on aiohttp and
// Azure Functions, each with safe and unsafe routes. No real keys: everything is read from
// environment variables that do not exist.

export const SAMPLE_PY_ROUTES = {
  // ------------------------------------------------------------------ Flask
  "web/app.py": `
import logging
import os

import requests
from flask import Flask, jsonify, request
from flask_limiter import Limiter
from flask_login import login_required
from openai import OpenAI

app = Flask(__name__)
limiter = Limiter(app)
client = OpenAI()


@app.route("/api/chat", methods=["POST"])
def chat():
    # Unsafe: no login check, the client picks the model, no rate limit, no size limit.
    body = request.get_json()
    reply = client.chat.completions.create(model=body.get("model"), messages=[{"role": "user", "content": body["message"]}])
    return jsonify(reply.choices[0].message.content)


@app.route("/api/summary", methods=["POST"])
@login_required
@limiter.limit("10/minute")
def summary():
    text = request.json["text"][:4000]
    reply = client.chat.completions.create(model="gpt-4o-mini", max_tokens=300, messages=[{"role": "user", "content": text}])
    return jsonify(reply.choices[0].message.content)


@app.route("/health")
def health():
    return {"ok": True}


@app.get("/api/preview")
def preview():
    # Unsafe: no login check, fetches any URL, logs a token.
    url = request.args.get("url")
    logging.info("preview with %s", os.environ.get("SERVICE_TOKEN"))
    return requests.get(url).text


@app.route("/api/users/delete")
@login_required
def delete_user():
    # Unsafe: GET that deletes, user id from the request.
    uid = request.args.get("user_id")
    db.execute("DELETE FROM users WHERE id = %s", (uid,))
    db.commit()
    return {"deleted": uid}
`,

  // ------------------------------------------------------------------ FastAPI
  "api/main.py": `
from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, Field

from .ai import ask
from .deps import get_current_user

app = FastAPI()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")
router = APIRouter(prefix="/v1")
secure = APIRouter(prefix="/admin", dependencies=[Depends(get_current_user)])


class Question(BaseModel):
    text: str = Field(max_length=2000)


@router.post("/ask")
async def ask_route(q: Question, user=Depends(get_current_user)):
    # Logged in, size limited, but no rate limit on an LLM call.
    return {"answer": ask(q.text)}


@app.get("/items/{item_id}")
async def read_item(item_id: int, token: str = Depends(oauth2_scheme)):
    return {"id": item_id}


@secure.post("/reindex")
async def reindex():
    return {"ok": True}


@app.post("/webhooks/stripe")
async def stripe_hook(request: Request):
    # Unsafe: does not verify the signature.
    payload = await request.body()
    return {"received": len(payload)}
`,
  "api/ai.py": `
import anthropic

client = anthropic.Anthropic()


def ask(text):
    return client.messages.create(model="claude-haiku", max_tokens=500, messages=[{"role": "user", "content": text}])
`,
  "api/deps.py": `
from fastapi import Depends
from fastapi.security import OAuth2PasswordBearer

oauth2 = OAuth2PasswordBearer(tokenUrl="token")


def get_current_user(token: str = Depends(oauth2)):
    return decode(token)
`,

  // ------------------------------------------------------------------ Teams bot (aiohttp)
  "bot/app.py": `
from aiohttp import web
from botbuilder.core import BotFrameworkAdapter, BotFrameworkAdapterSettings
from botbuilder.schema import Activity

from .bot import ReportBot
from .config import DefaultConfig

CONFIG = DefaultConfig()
SETTINGS = BotFrameworkAdapterSettings(CONFIG.APP_ID, CONFIG.APP_PASSWORD)
ADAPTER = BotFrameworkAdapter(SETTINGS)
BOT = ReportBot()


async def messages(req: web.Request) -> web.Response:
    body = await req.json()
    activity = Activity().deserialize(body)
    auth_header = req.headers.get("Authorization", "")
    response = await ADAPTER.process_activity(activity, auth_header, BOT.on_turn)
    return web.json_response(data=response.body if response else None)


async def trigger(req: web.Request) -> web.Response:
    # Unsafe: anyone can start the pipeline, which calls the LLM.
    await BOT.run_pipeline()
    return web.Response(text="started")


APP = web.Application()
APP.router.add_post("/api/messages", messages)
APP.router.add_post("/api/trigger", trigger)
`,
  "bot/config.py": `
import os


class DefaultConfig:
    APP_ID = os.environ.get("MicrosoftAppId", "")
    APP_PASSWORD = os.environ.get("MicrosoftAppPassword", "")
`,
  "bot/bot.py": `
from openai import AzureOpenAI

client = AzureOpenAI()


class ReportBot:
    async def on_turn(self, turn_context):
        text = turn_context.activity.text[:2000]
        client.chat.completions.create(model="gpt-4o", max_tokens=400, messages=[{"role": "user", "content": text}])

    async def run_pipeline(self):
        client.chat.completions.create(model="gpt-4o", max_tokens=400, messages=[])
`,

  // ------------------------------------------------------------------ Azure Functions
  "functions/function_app.py": `
import os

import azure.functions as func
from supabase import create_client

app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)


@app.route(route="sync", auth_level=func.AuthLevel.ANONYMOUS, methods=["POST"])
def sync(req: func.HttpRequest) -> func.HttpResponse:
    # Unsafe: anonymous, and writes with the Supabase secret key.
    db = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    db.table("products").upsert({"id": 1})
    return func.HttpResponse("ok")


@app.route(route="status")
def status(req: func.HttpRequest) -> func.HttpResponse:
    return func.HttpResponse("ok")
`,

  // ------------------------------------------------------------------ ignored
  "tests/test_api.py": `
from fastapi import FastAPI

app = FastAPI()


@app.get("/only-in-tests")
def nope():
    return {}
`,
};

/** Expected findings per endpoint label ("METHODS /route"). */
export const EXPECTED_PY_FINDINGS = {
  "POST /api/chat": ["llm-input-limit", "llm-rate-limit", "llm-settings", "no-auth"],
  "GET /api/preview": ["logs-secret", "no-auth", "ssrf"],
  "GET /api/users/delete": ["get-writes", "identity"],
  "POST /v1/ask": ["llm-rate-limit"],
  "POST /webhooks/stripe": ["webhook-signature"],
  "POST /api/messages": ["llm-rate-limit"],
  "POST /api/trigger": ["llm-rate-limit", "no-auth"],
  "POST /api/sync": ["no-auth"],
};
