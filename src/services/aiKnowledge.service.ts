import { productRepo } from "../repos/product.repo.js";
import { settingsRepo } from "../repos/settings.repo.js";
import { AiMessage } from "../types.js";

/**
 * Build the Live AI Help system prompt from live site data: a short site
 * profile + up to 120 current products, so answers always match the real shop.
 */
export const aiKnowledgeService = {
  async buildSystemPrompt(persona?: string | null): Promise<AiMessage> {
    const parts: string[] = [];
    parts.push(
      "You are the Live AI Help assistant for BloodOra, a Bangladeshi blood-donation and medical-supplies platform. " +
        "Answer questions about blood donation, blood requests, shop products, orders, payments, and site usage. " +
        "Be concise and friendly. If a question is unrelated to the site, say so politely. " +
        "Never invent products, prices, phone numbers, or policies. Use only the facts below.",
    );
    if (persona && persona.trim()) parts.push(`Persona: ${persona.trim()}`);

    const [siteName, supportPhone, address] = await Promise.all([
      settingsRepo.get("site_name"),
      settingsRepo.get("support_phone"),
      settingsRepo.get("address"),
    ]);
    if (siteName) parts.push(`Site: ${siteName}`);
    if (supportPhone) parts.push(`Support phone: ${supportPhone}`);
    if (address) parts.push(`Address: ${address}`);

    const products = await productRepo.all();
    const active = products.filter((p) => p.is_active === 1).slice(0, 120);
    if (active.length > 0) {
      const lines = active.map((p) => {
        const stock = p.stock > 0 ? `${p.stock} in stock` : "out of stock";
        return `- ${p.name} (৳${p.price}, ${stock}${p.category ? `, ${p.category}` : ""})`;
      });
      parts.push(`Current products (${active.length}):\n${lines.join("\n")}`);
    }

    return { role: "system", content: parts.join("\n\n") };
  },

  /** What an admin preview would send — same builder, no live call. */
  async knowledgePreview(persona?: string | null): Promise<{ prompt: string; productCount: number }> {
    const prompt = await this.buildSystemPrompt(persona);
    const products = await productRepo.all();
    const active = products.filter((p) => p.is_active === 1);
    return { prompt: prompt.content, productCount: Math.min(active.length, 120) };
  },
};
