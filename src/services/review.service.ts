import { reviewRepo } from "../repos/review.repo.js";
import { orderRepo } from "../repos/order.repo.js";
import { userRepo } from "../repos/user.repo.js";
import { productRepo } from "../repos/product.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { randomId, ApiError } from "../utils/errors.js";
import { str } from "../utils/validate.js";
import type { SafeUser } from "../types.js";

function clampRating(v: unknown): number {
  const n = parseInt(String(v), 10);
  if (Number.isNaN(n)) return 5;
  return Math.min(5, Math.max(1, n));
}

export const reviewService = {
  /**
   * POST /api/reviews — product review (requires a prior order) or site
   * testimonial. Original contract.
   */
  async submit(user: SafeUser, body: Record<string, unknown>): Promise<{ type: string; message: string }> {
    const text = (str(body.body) ?? "").trim();
    const title = (str(body.title) ?? "").trim();
    const rating = clampRating(body.rating);
    const productId = str(body.product_id);

    if (!text || text.length < 10) throw ApiError.badRequest("❌ Please write at least 10 characters.", "BODY_TOO_SHORT");
    if (title.length > 120) throw ApiError.badRequest("❌ Title too long (max 120 characters).", "TITLE_TOO_LONG");
    if (text.length > 2000) throw ApiError.badRequest("❌ Review too long (max 2000 characters).", "BODY_TOO_LONG");

    let kind = "site";
    if (productId) {
      const product = await productRepo.findById(productId);
      if (!product) throw ApiError.notFound("❌ That product does not exist.", "PRODUCT_NOT_FOUND");
      const ordered = await orderRepo.itemsForProductAndUser(user.id, productId);
      if (!ordered) {
        throw ApiError.badRequest(
          `❌ You can only review “${product.name}” after ordering it. You can still leave a general testimonial instead.`,
          "NO_PRIOR_ORDER",
        );
      }
      kind = "product";
    }

    const dupe = await reviewRepo.recentDuplicate(user.id, productId || null);
    if (dupe) {
      throw ApiError.conflict("⚠️ You already reviewed this recently. Please wait a day before posting another.", "REVIEW_TOO_SOON");
    }

    const id = randomId();
    await reviewRepo.create({
      id,
      product_id: productId || null,
      user_id: user.id,
      author_name: user.name,
      kind,
      rating,
      title: title || null,
      body: text,
      status: "pending",
      is_approved: 0,
      is_featured: 0,
      admin_reply: null,
      admin_replied_at: null,
    });
    await activityRepo.create("review", user.id, `New ${kind} review submitted (${rating}★) — awaiting moderation`);
    return {
      type: "success",
      message: "✅ Thank you! Your review was submitted and will appear once an admin approves it.",
    };
  },

  /** GET /api/reviews/mine */
  async mine(user: SafeUser) {
    return { success: true, reviews: await reviewRepo.byUser(user.id) };
  },

  // ---------- moderation ----------

  /** GET /api/reviews/admin?status= */
  async adminList(status?: string) {
    const [reviews, counts] = await Promise.all([reviewRepo.listByStatus(status || null), reviewRepo.counts()]);
    return { success: true, reviews, counts };
  },

  /** POST /api/reviews/admin/:id/status — {status: pending|approved|rejected}. */
  async adminSetStatus(actor: SafeUser, id: string, status: string): Promise<string> {
    if (!["approved", "rejected", "pending"].includes(status)) throw ApiError.badRequest("❌ Invalid status.", "BAD_STATUS");
    const review = await reviewRepo.findById(id);
    if (!review) throw ApiError.notFound("Review not found.", "REVIEW_NOT_FOUND");
    await reviewRepo.setStatus(id, status);
    const product = review.product_id ? await productRepo.findById(review.product_id) : null;
    await activityRepo.create(
      status === "approved" ? "review_approve" : "review_reject",
      actor.id,
      `Review for "${product?.name || "site"}" ${status}`,
    );
    return status === "approved" ? "✅ Review approved." : status === "rejected" ? "✅ Review rejected." : "ℹ️ Review moved back to pending.";
  },

  /** POST /api/reviews/admin/:id/feature — toggle featured. */
  async adminFeature(actor: SafeUser, id: string): Promise<string> {
    const review = await reviewRepo.findById(id);
    if (!review) throw ApiError.notFound("Review not found.", "REVIEW_NOT_FOUND");
    const next = review.is_featured ? 0 : 1;
    await reviewRepo.setFeatured(id, next === 1);
    await activityRepo.create("review_feature", actor.id, `Review ${next ? "featured" : "unfeatured"}`);
    return next ? "⭐ Review featured." : "ℹ️ Review unfeatured.";
  },

  /** POST /api/reviews/admin/:id/reply — {admin_reply}. */
  async adminReply(actor: SafeUser, id: string, reply: string): Promise<string> {
    const text = reply.trim();
    if (!text) throw ApiError.badRequest("Reply text is required.", "REPLY_REQUIRED");
    const review = await reviewRepo.findById(id);
    if (!review) throw ApiError.notFound("Review not found.", "REVIEW_NOT_FOUND");
    await reviewRepo.setAdminReply(id, text);
    await activityRepo.create("review_reply", actor.id, `Replied to review ${id}`);
    return "✅ Reply saved.";
  },

  /** DELETE /api/reviews/admin/:id */
  async adminDelete(actor: SafeUser, id: string): Promise<string> {
    const review = await reviewRepo.findById(id);
    if (!review) throw ApiError.notFound("Review not found.", "REVIEW_NOT_FOUND");
    await reviewRepo.delete(id);
    await activityRepo.create("review_delete", actor.id, `Review ${id} deleted`);
    return "✅ Review deleted.";
  },
};
