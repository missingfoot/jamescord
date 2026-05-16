import Anthropic from '@anthropic-ai/sdk';
import type { Persona } from './personas.js';

const client = new Anthropic();

export type RecentMessage = {
	author: string;
	text: string;
};

const MODEL = 'claude-haiku-4-5';

const SHARED_RULES = `You are simulating a person in a casual team chat app. Rules:
- Reply in character as the specified person.
- Reply in 1–2 short sentences, max 25 words. Often just one short sentence.
- Lowercase is fine, contractions are fine, mild typos are fine — this is chat, not email.
- No quote marks around your reply. No "Here's a reply:" preamble.
- Do not roleplay actions in asterisks. Do not use markdown formatting.
- Do not @mention people by name unless replying directly to them.
- It is fine and good to be brief, even just "lol" or "+1" or "nope" when it fits.
- Never break character or mention that you are an AI.`;

function buildSystem(persona: Persona, room: string): Anthropic.TextBlockParam[] {
	const personaBlock = `You are ${persona.nickname}.
Voice: ${persona.voice}
You are chatting in the room "${room}".`;
	return [
		// SHARED_RULES is byte-identical across every persona, so we mark it
		// cacheable. Caching only actually kicks in on prefixes ≥4096 tokens,
		// which we won't reliably hit here, but the marker is free.
		{ type: 'text', text: SHARED_RULES, cache_control: { type: 'ephemeral' } },
		{ type: 'text', text: personaBlock }
	];
}

function buildContext(recent: RecentMessage[], persona: Persona): string {
	if (!recent.length) {
		return `The room is quiet. Open a thread of conversation — share a thought, ask a question, or post a small update related to your interests. Keep it light.`;
	}
	const transcript = recent
		.slice(-12)
		.map((m) => `${m.author}: ${m.text}`)
		.join('\n');
	return `Recent messages:\n${transcript}\n\nWrite the next message as ${persona.nickname}. You can reply to something said, or pivot to a related topic. Don't repeat what was just said.`;
}

export async function generateMessage(
	persona: Persona,
	room: string,
	recent: RecentMessage[]
): Promise<string | null> {
	try {
		const response = await client.messages.create({
			model: MODEL,
			max_tokens: 120,
			system: buildSystem(persona, room),
			messages: [{ role: 'user', content: buildContext(recent, persona) }]
		});
		const block = response.content.find((b) => b.type === 'text');
		if (!block || block.type !== 'text') return null;
		return cleanupReply(block.text);
	} catch (err) {
		console.error(`[claude] ${persona.nickname} generation failed:`, err instanceof Error ? err.message : err);
		return null;
	}
}

export async function generateDmToUser(
	persona: Persona,
	userNickname: string,
	recent: RecentMessage[]
): Promise<string | null> {
	try {
		const userBlock = recent.length
			? `Your DM history with ${userNickname}:\n${recent
					.slice(-8)
					.map((m) => `${m.author}: ${m.text}`)
					.join('\n')}\n\nWrite your next message to ${userNickname}.`
			: `Open a friendly 1:1 DM with ${userNickname}. Could be a small question, a quick share, or a low-stakes hello.`;
		const response = await client.messages.create({
			model: MODEL,
			max_tokens: 120,
			system: buildSystem(persona, `DM with ${userNickname}`),
			messages: [{ role: 'user', content: userBlock }]
		});
		const block = response.content.find((b) => b.type === 'text');
		if (!block || block.type !== 'text') return null;
		return cleanupReply(block.text);
	} catch (err) {
		console.error(`[claude] ${persona.nickname} DM generation failed:`, err instanceof Error ? err.message : err);
		return null;
	}
}

function cleanupReply(s: string): string {
	let out = s.trim();
	// Strip surrounding quotes the model sometimes adds despite the rules.
	if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
		out = out.slice(1, -1).trim();
	}
	// Strip "nickname:" prefix if the model accidentally writes one.
	out = out.replace(/^[a-z0-9_-]{1,20}:\s*/i, '');
	return out;
}
