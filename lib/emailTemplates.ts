// Task 5 — the reusable email templates ("~10 rotating emails" per Lamarr).
//
// These live in config because GHL template listing via the PIT is not
// confirmed API-listable (see scripts/email-probe.mjs). If Step 0 shows GHL
// templates ARE listable, the email route can merge them in; until then this is
// the single source of truth. Jack/Lamarr supply the real copy — replace the
// placeholder subject/body below, keeping the {{tokens}}.
//
// Supported tokens (substituted at populate time, client-side):
//   {{clientFirst}} {{clientLast}} {{clientName}} {{caregiverName}}
//   {{office}} {{stage}}
// Unknown/empty tokens render as an empty string.

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string; // HTML or plain text; newlines are converted to <br> on send
}

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: "welcome",
    name: "1 · Welcome / Intro",
    subject: "Welcome to Miracle Makers, {{clientFirst}}",
    body:
      "Hi {{clientName}},\n\n" +
      "Thank you for choosing Miracle Makers. We're excited to support your care journey. " +
      "Your enrollment is being processed and we'll be in touch with next steps shortly.\n\n" +
      "Warm regards,\nThe Miracle Makers Team",
  },
  {
    id: "documents-needed",
    name: "2 · Documents needed",
    subject: "Documents needed to continue your enrollment",
    body:
      "Hi {{clientName}},\n\n" +
      "To keep your enrollment moving, we still need a few documents from you. " +
      "Please reply to this email with the requested items at your earliest convenience.\n\n" +
      "Thank you,\nThe Miracle Makers Team",
  },
  {
    id: "caregiver-intro",
    name: "3 · Caregiver introduction",
    subject: "Introducing your caregiver",
    body:
      "Hi {{clientName}},\n\n" +
      "We're pleased to introduce {{caregiverName}}, who will be supporting your care. " +
      "Please let us know if you have any questions.\n\n" +
      "Best,\nThe Miracle Makers Team",
  },
  {
    id: "check-in",
    name: "4 · Weekly check-in",
    subject: "Checking in from Miracle Makers",
    body:
      "Hi {{clientName}},\n\n" +
      "We're checking in to see how things are going. If there's anything you need, " +
      "just reply to this email and we'll help right away.\n\n" +
      "Take care,\nThe Miracle Makers Team",
  },
  {
    id: "authorization-update",
    name: "5 · Authorization update",
    subject: "An update on your authorization",
    body:
      "Hi {{clientName}},\n\n" +
      "We have an update regarding your authorization. Please reach out so we can walk " +
      "you through the details.\n\n" +
      "Regards,\nThe Miracle Makers Team",
  },
  {
    id: "scheduling",
    name: "6 · Scheduling",
    subject: "Let's schedule your next step",
    body:
      "Hi {{clientName}},\n\n" +
      "We'd like to schedule your next step. Please reply with a few times that work for " +
      "you and we'll confirm.\n\nThank you,\nThe Miracle Makers Team",
  },
  {
    id: "reminder",
    name: "7 · Friendly reminder",
    subject: "A friendly reminder from Miracle Makers",
    body:
      "Hi {{clientName}},\n\n" +
      "Just a friendly reminder about your pending items. Let us know if you need anything " +
      "to complete them.\n\nBest,\nThe Miracle Makers Team",
  },
  {
    id: "roadblock",
    name: "8 · Road-blocker follow-up",
    subject: "Let's resolve a hold-up on your enrollment",
    body:
      "Hi {{clientName}},\n\n" +
      "We noticed something is holding up your enrollment and want to help resolve it. " +
      "Please reply and we'll sort it out together.\n\nRegards,\nThe Miracle Makers Team",
  },
  {
    id: "onboarding-complete",
    name: "9 · Onboarding complete",
    subject: "You're all set with Miracle Makers",
    body:
      "Hi {{clientName}},\n\n" +
      "Great news — your onboarding is complete! {{caregiverName}} and our team are here " +
      "whenever you need us.\n\nWelcome aboard,\nThe Miracle Makers Team",
  },
  {
    id: "general",
    name: "10 · General message",
    subject: "A message from Miracle Makers",
    body:
      "Hi {{clientName}},\n\n" +
      "We wanted to reach out with an update. Please let us know if you have any questions.\n\n" +
      "Best,\nThe Miracle Makers Team",
  },
];
