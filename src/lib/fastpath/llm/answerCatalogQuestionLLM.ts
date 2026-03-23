// src/lib/fastpath/llm/answerCatalogQuestionLLM.ts
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function answerCatalogQuestionLLM(params: {
  idiomaDestino: "es" | "en";
  systemMsg: string;
  userMsg: string;
}) {
  const { systemMsg, userMsg } = params;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemMsg },
      { role: "user", content: userMsg },
    ],
    temperature: 0.4,
  });

  const reply = completion.choices[0]?.message?.content ?? "";
  return reply.trim();
}