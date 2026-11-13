from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from agent import agent
import jwt
import os

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3003"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True, 
)

JWT_SECRET = os.environ["JWT_SECRET"]  # must match the exact value in storefront-be's .env

class AgentRequest(BaseModel):
    message: str

def require_premium(request: Request) -> dict:
    token = request.cookies.get("token")
    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized")

    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Unauthorized")

    if payload.get("role") != "PREMIUM":
        raise HTTPException(status_code=403, detail="Forbidden")

    return payload

@app.post("/api/agent/chat")
def agent_chat(req: AgentRequest, request: Request):
    require_premium(request)  # 👈 raises before any agent logic runs if not premium/authenticated

    result = agent.invoke({"messages": [{"role": "user", "content": req.message}]})
    last_message = result["messages"][-1]
    return {"response": last_message.content}