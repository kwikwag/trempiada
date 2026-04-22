import type { Gender, TrustVerification, VerificationType } from "../../types";

export const SOCIAL_VERIFICATION_TYPES = ["facebook", "linkedin", "google", "email"] as const;
type SocialVerificationType = (typeof SOCIAL_VERIFICATION_TYPES)[number];

const GENDER_LABELS: Record<Gender, string> = {
  male: "Male",
  female: "Female",
  other: "Other",
};

const VERIFICATION_LABELS: Record<SocialVerificationType, string> = {
  facebook: "Facebook",
  linkedin: "LinkedIn",
  google: "Google",
  email: "Email",
};

export type RestartProfileChoice = "car" | "socials";

export function getSocialVerificationTypes(verifications: TrustVerification[]): VerificationType[] {
  return verifications.filter((v) => isSocialVerificationType(v.type)).map((v) => v.type);
}

export function formatVerificationTypes(types: VerificationType[]): string {
  return types
    .map((type) => (isSocialVerificationType(type) ? VERIFICATION_LABELS[type] : type))
    .join(", ");
}

export function nextRestartProfileChoice({
  hasActiveCar,
  socialTypes,
  removeCar,
  removeSocials,
}: {
  hasActiveCar: boolean;
  socialTypes: VerificationType[];
  removeCar?: boolean;
  removeSocials?: boolean;
}): RestartProfileChoice | null {
  if (hasActiveCar && typeof removeCar !== "boolean") return "car";
  if (socialTypes.length > 0 && typeof removeSocials !== "boolean") return "socials";
  return null;
}

export function buildRestartConfirmationText({
  newName,
  newGender,
  newPhotoFileId,
  hasActiveCar,
  socialTypes,
  removeCar,
  removeSocials,
}: {
  newName: unknown;
  newGender: unknown;
  newPhotoFileId: unknown;
  hasActiveCar: boolean;
  socialTypes: VerificationType[];
  removeCar?: boolean;
  removeSocials?: boolean;
}): string {
  const lines = [
    "Here's your new profile:\n",
    `👤 Name: ${String(newName ?? "")}`,
    `⚧ Gender: ${isGender(newGender) ? GENDER_LABELS[newGender] : "Not set"}`,
    `📸 Photo: ${newPhotoFileId ? "✅" : "❌"}`,
  ];

  if (hasActiveCar && typeof removeCar === "boolean") {
    lines.push(`🚗 Car: ${removeCar ? "Remove from profile" : "Keep on profile"}`);
  }

  if (socialTypes.length > 0 && typeof removeSocials === "boolean") {
    lines.push(
      `🔗 Social accounts: ${
        removeSocials
          ? `Forget ${formatVerificationTypes(socialTypes)}`
          : `Keep ${formatVerificationTypes(socialTypes)}`
      }`,
    );
  }

  return lines.join("\n");
}

function isGender(value: unknown): value is Gender {
  return value === "male" || value === "female" || value === "other";
}

function isSocialVerificationType(type: VerificationType): type is SocialVerificationType {
  return (SOCIAL_VERIFICATION_TYPES as readonly VerificationType[]).includes(type);
}
