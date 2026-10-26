import { UserProfile, ProfileChange, type UserProfileSnapshot, type UserProfilePatch } from "../domain/user-profile.js";
import { ApplicationError } from "../../../../common/application/application-error.js";
export type Profile = UserProfileSnapshot;
export type ProfilePatch = UserProfilePatch;
export interface ProfileRepository {
    find(subject: string): Promise<Profile>;
    /** Update an existing USER_PROFILE only; never upsert a missing/unrelated row. */
    update(subject: string, patch: ProfilePatch): Promise<void>;
}
export interface ProfileAvatars {
    exists(key: string): Promise<boolean>;
    publicUrl(key: string): string;
}
export class ProfileQueries {
    constructor(private readonly profiles: ProfileRepository, private readonly avatars: ProfileAvatars) { }
    async get(subject: string) {
        const profile = new UserProfile(subject, await this.profiles.find(subject)).toSnapshot();
        return { ...profile, avatarUrl: this.avatars.publicUrl(profile.avatarKey) };
    }
}
export class UpdateProfile {
    constructor(private readonly profiles: ProfileRepository, private readonly avatars: ProfileAvatars, private readonly queries: ProfileQueries) { }
    async execute(subject: string, patch: ProfilePatch) {
        const change = new ProfileChange(subject, patch);
        change.assertAllowed();
        if (change.avatarKey) {
            if (!await this.avatars.exists(change.avatarKey))
                throw new ApplicationError("INVALID_INPUT", "Avatar image does not exist.");
        }
        await this.profiles.update(subject, change.toSnapshot());
        return this.queries.get(subject);
    }
}
