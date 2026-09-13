import { bloodRequestRepo } from "../repos/bloodRequest.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { messageService } from "./message.service.js";
import { randomId, ApiError } from "../utils/errors.js";
import { str } from "../utils/validate.js";
import { BLOOD_GROUPS } from "../data/constants.js";
import type { BloodRequest, SafeUser } from "../types.js";

const STATUSES = ["open", "confirmed", "fulfilled", "cancelled"];

/** "Muhammad Ashraf" → "MA" (activity detail). */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() || "")
    .slice(0, 2)
    .join("");
}

/** Normalize row for the public API (original contract booleans). */
export function publicRequest(row: BloodRequest & { requester_name?: string | null }): Record<string, unknown> {
  return {
    ...row,
    is_urgent: Boolean(row.urgent),
    is_fulfilled: Boolean(row.is_fulfilled),
  };
}

export const bloodRequestService = {
  /**
   * POST /api/blood-requests — create (guests allowed). Original field names:
   * patient_name, blood_group, hospital_name, contact_person, contact_phone,
   * needed_by, division, district, upazila, is_urgent, ...
   */
  async create(user: SafeUser | null, body: Record<string, unknown>): Promise<{ type: string; message: string }> {
    const b = (k: string) => str(body[k]);
    const required: Record<string, string | undefined> = {
      "Patient Name": b("patient_name"),
      "Blood Group": b("blood_group"),
      "Hospital Name": b("hospital_name"),
      "Contact Person": b("contact_person"),
      "Contact Phone": b("contact_phone"),
      "Needed By": b("needed_by"),
      Division: b("division"),
      District: b("district"),
      Upazila: b("upazila"),
    };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      throw ApiError.badRequest(`❌ Please fill all required fields: ${missing.join(", ")}`, "FIELDS_REQUIRED");
    }
    const R = required as Record<string, string>;

    const group = R["Blood Group"].toUpperCase().trim();
    if (!BLOOD_GROUPS.includes(group)) {
      throw ApiError.badRequest(`Blood group must be one of: ${BLOOD_GROUPS.join(", ")}`, "BAD_BLOOD_GROUP");
    }

    let neededBy = R["Needed By"];
    try {
      neededBy = new Date(R["Needed By"]).toISOString();
    } catch {
      /* keep raw */
    }

    const isUrgent = ["1", "true", "yes", "on"].includes(String(body.is_urgent ?? body.urgent ?? "").toLowerCase()) ? 1 : 0;
    const now = new Date().toISOString();
    const id = randomId();
    const division = R.Division;
    const district = R.District;
    const upazila = R.Upazila;
    const quantity = b("quantity") || "1 unit";
    const units = Math.max(1, Math.min(10, parseInt(quantity, 10) || 1));

    await bloodRequestRepo.create({
      id,
      user_id: user?.id ?? null,
      // legacy columns (kept populated for old consumers)
      name: R["Patient Name"],
      phone: R["Contact Phone"],
      hospital: R["Hospital Name"],
      patient_name: R["Patient Name"],
      patient_relation: b("patient_relation") || "Self",
      hospital_name: R["Hospital Name"],
      hospital_address: b("hospital_address") || `${upazila}, ${district}, ${division}`,
      contact_person: R["Contact Person"],
      contact_phone: R["Contact Phone"],
      contact_email: b("contact_email") || null,
      urgent_reason: b("urgent_reason") || null,
      needed_by: neededBy,
      additional_info: b("additional_info") || null,
      blood_group: group,
      units,
      quantity,
      division,
      district,
      upazila,
      location_division: division,
      location_district: district,
      location_upazila: upazila,
      urgent: isUrgent,
      status: "open",
      is_fulfilled: 0,
      fulfilled_at: null,
      fulfilled_by: null,
      note: b("additional_info") || null,
      updated_at: now,
    });

    const link = `/blood-request/${id}`;
    const detail = `${district}${upazila ? ", " + upazila : ""} • for ${initials(R["Patient Name"])}`;
    await activityRepo.create(
      isUrgent ? "request_urgent" : "request_posted",
      null,
      isUrgent ? `URGENT: ${group} needed at ${R["Hospital Name"]}` : `${group} needed — ${R["Hospital Name"]}`,
      { detail, link },
    );

    return {
      type: isUrgent ? "warning" : "success",
      message: isUrgent
        ? "🚨 URGENT blood request submitted! Donors will be notified."
        : "✅ Blood request submitted successfully! Thank you.",
    };
  },

  /** GET /api/blood-requests — public list with filters. */
  async listPublic(opts: { bg?: string; dist?: string; division?: string; urgent?: string }) {
    const rows = await bloodRequestRepo.listPublic({
      group: opts.bg,
      division: opts.division,
      dist: opts.dist,
      urgent: opts.urgent === "true" || opts.urgent === "1",
    });
    return { success: true, requests: rows.map((r) => publicRequest(r as never)) };
  },

  /** GET /api/blood-requests/urgent */
  async urgentList() {
    const rows = await bloodRequestRepo.listUrgent();
    return { success: true, requests: rows.map((r) => publicRequest(r as never)) };
  },

  /** GET /api/blood-requests/:id */
  async get(id: string): Promise<Record<string, unknown>> {
    const row = await bloodRequestRepo.findById(id);
    if (!row) throw ApiError.notFound("Request not found.", "REQUEST_NOT_FOUND");
    return publicRequest(row as never);
  },

  /** POST /api/blood-requests/:id/fulfill — any logged-in donor. */
  async fulfill(user: SafeUser, id: string): Promise<{ type: string; message: string }> {
    const br = await bloodRequestRepo.findById(id);
    if (!br) throw ApiError.notFound("Request not found.", "REQUEST_NOT_FOUND");
    if (br.is_fulfilled) return { type: "info", message: "ℹ️ Already fulfilled." };
    await bloodRequestRepo.fulfill(id, user.id);
    await activityRepo.create(
      "request_fulfilled",
      null,
      `${br.blood_group} request fulfilled`,
      { detail: `${br.location_district || "Bangladesh"} • by ${initials(user.name)}`, link: `/blood-request/${br.id}` },
    );
    return {
      type: "success",
      message: br.urgent
        ? "✅ Urgent request marked as fulfilled. Thank you for donating!"
        : "✅ Blood request marked as fulfilled. Thank you!",
    };
  },

  /** POST /api/blood-requests/:id/cancel — requester or admin. */
  async cancel(user: SafeUser, id: string): Promise<{ type: string; message: string }> {
    const br = await bloodRequestRepo.findById(id);
    if (!br) throw ApiError.notFound("Request not found.", "REQUEST_NOT_FOUND");
    if (br.user_id !== user.id && !user.is_admin) {
      throw ApiError.forbidden("❌ You do not have permission to cancel this request.", "FORBIDDEN");
    }
    await bloodRequestRepo.cancel(id);
    return { type: "info", message: "ℹ️ Blood request cancelled." };
  },

  /** POST /api/blood-requests/urgent-contact — urgent-page contact form. */
  async urgentContact(user: SafeUser | null, body: Record<string, unknown>): Promise<{ message: string }> {
    const subject = str(body.subject);
    const message = str(body.message);
    const email = str(body.email);
    if (!message) throw ApiError.badRequest("Message is required.", "FIELDS_REQUIRED");
    if (user) {
      // Reuse the desk mailbox (recipient 'admin').
      await messageService.send(user, {
        subject: subject || "🚨 URGENT PAGE: Urgent Inquiry",
        content: `From: ${email || user.email}\n\n${message}`,
      });
    }
    return { message: "✅ Your message has been sent to the BloodOra admin team!" };
  },

  // ---------- admin / old contract helpers ----------

  async mine(userId: string): Promise<BloodRequest[]> {
    const rows = await bloodRequestRepo.listAll({ limit: 100 });
    return rows.filter((r) => r.user_id === userId).map((r) => ({ ...r, user: null }));
  },

  async setStatus(actor: SafeUser, id: string, status: string): Promise<BloodRequest> {
    if (!STATUSES.includes(status)) {
      throw ApiError.badRequest(`Invalid status (expected: ${STATUSES.join(", ")})`, "BAD_STATUS");
    }
    const row = await bloodRequestRepo.findById(id);
    if (!row) throw ApiError.notFound("Blood request not found", "REQUEST_NOT_FOUND");
    await bloodRequestRepo.setStatus(id, status);
    await activityRepo.create("blood_status", actor.id, `Blood request ${id} → ${status}`);
    return this.get(id) as never;
  },

  async remove(actor: SafeUser, id: string): Promise<void> {
    const row = await bloodRequestRepo.findById(id);
    if (!row) throw ApiError.notFound("Blood request not found", "REQUEST_NOT_FOUND");
    await bloodRequestRepo.delete(id);
    await activityRepo.create("blood_delete", actor.id, `Blood request ${id} deleted`);
  },
};
