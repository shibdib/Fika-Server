import { container, inject, injectable } from "tsyringe";

import { IGroupCharacter } from "@spt/models/eft/match/IGroupCharacter";

import { IMatchGroupCurrentResponse } from "@spt/models/eft/match/IMatchGroupCurrentResponse";
import { IMatchGroupInviteSendRequest } from "@spt/models/eft/match/IMatchGroupInviteSendRequest";
import { IMatchGroupPlayerRemoveRequest } from "@spt/models/eft/match/IMatchGroupPlayerRemoveRequest";
import { IMatchGroupStartGameRequest } from "@spt/models/eft/match/IMatchGroupStartGameRequest";
import { IMatchGroupStatusRequest } from "@spt/models/eft/match/IMatchGroupStatusRequest";
import { IMatchGroupStatusResponse } from "@spt/models/eft/match/IMatchGroupStatusResponse";
import { IMatchGroupTransferRequest } from "@spt/models/eft/match/IMatchGroupTransferRequest";
import { IProfileStatusRequest } from "@spt/models/eft/match/IProfileStatusRequest";
import { IProfileStatusResponse } from "@spt/models/eft/match/IProfileStatusResponse";
import { IRequestIdRequest } from "@spt/models/eft/match/IRequestIdRequest";

import { FikaMatchService } from "../services/FikaMatchService";
import { SaveServer } from "@spt/servers/SaveServer";
import { HashUtil } from "@spt/utils/HashUtil";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { ISptProfile } from "@spt/models/eft/profile/ISptProfile";
import { SptWebSocketConnectionHandler } from "@spt/servers/ws/SptWebSocketConnectionHandler";
import { IEmptyRequestData } from "@spt/models/eft/common/IEmptyRequestData";

class Group {
    public owner: number;
    public invites: Map<string, IGroupInvite>;
    public members: Map<number, IGroupCharacter>;

    constructor(owner: number) {
        this.owner = owner;
        this.invites = new Map<string, IGroupInvite>();
        this.members = new Map<number, IGroupCharacter>();
    }
}

interface IGroupInvite {
    sender: number;
    recipient: number;
}

@injectable()
export class FikaMatchController {
    private groups: Group[];
    static hasStarted: boolean = false;

    constructor(
        @inject("FikaMatchService") protected fikaMatchService: FikaMatchService,
        @inject("SaveServer") protected saveServer: SaveServer,
        @inject("HashUtil") protected hashUtil: HashUtil,
        @inject("WinstonLogger") protected logger: ILogger,
        @inject("SptWebSocketConnectionHandler") protected webSocketHandler: SptWebSocketConnectionHandler,
    ) {
        this.groups = [];
        this.logger.info("FikaMatchController constructed");
    }

    getProfileByAID(aid: number): ISptProfile {
        for (const profile of Object.values(this.saveServer.getProfiles())) {
            if (profile.info.aid == aid) {
                return profile;
            }
        }

        return undefined;
    }

    /** Handle /client/match/exit */
    public handleMatchExit(sessionID: string): void {
        this.logger.warning("Default implementation of handleMatchExit");
    }

    /** Handle /client/match/group/current */
    public handleMatchGroupCurrent(sessionID: string): IMatchGroupCurrentResponse {
        this.logger.warning("Default implementation of handleMatchGroupCurrent");
        return {
            squad: [],
        };
    }

    /** Handle /client/match/group/delete */
    public handleMatchGroupDelete(sessionID: string): boolean {
        this.logger.warning("Default implementation of handleMatchGroupDelete");
        return true;
    }

    /** Handle /client/match/group/exit_from_menu */
    public handleMatchGroupExitFromMenu(sessionID: string): void {
        this.logger.warning("Default implementation of handleMatchGroupExitFromMenu");
    }

    /** Handle /client/match/group/invite/accept */
    public handleMatchGroupInviteAccept(info: IRequestIdRequest, sessionID: string): IGroupCharacter[] {
        const group = this.groups.find(g => g.invites.has(info.requestId));
        if (!group) {
            this.logger.error(`handleMatchGroupInviteAccept: Failed to find invite ${info.requestId}`);
            return [];
        }

        if (!group.invites.delete(info.requestId)) {
            this.logger.error(`handleMatchGroupInviteAccept: Failed to remove invite ${info.requestId}`);
            return [];
        }

        const profile = this.saveServer.getProfile(sessionID);
        const profileInfo: IGroupCharacter = {
            _id: profile.info.id,
            aid: profile.info.aid,
            Info: {
                Nickname: profile.characters.pmc.Info.Nickname,
                Side: profile.characters.pmc.Info.Side,
                Level: profile.characters.pmc.Info.Level,
                MemberCategory: profile.characters.pmc.Info.MemberCategory,
                GameVersion: profile.info.edition,
                SavageLockTime: profile.characters.scav.Info.SavageLockTime,
                SavageNickname: profile.characters.scav.Info.Nickname,
                hasCoopExtension: true
            },
            isLeader: false
        };

        group.members.set(profile.info.aid, profileInfo);

        for (const [_, member] of group.members) {
            this.webSocketHandler.sendMessage(member._id, {
                type: "groupMatchInviteAccept",
                eventId: "groupMatchInviteAccept",
                aid: profile.info.aid,
                _id: profile.info.id,
                Info: profileInfo.Info,
                IsReady: false,
                PlayerVisualRepresentation: null
            } as any);
        }

        return Array.from(group.members.values());
    }

    /** Handle /client/match/group/invite/cancel */
    public handleMatchGroupInviteCancel(info: IRequestIdRequest, sessionID: string): boolean {
        const group = this.groups.find(g => g.invites.has(info.requestId));
        if (!group) {
            this.logger.error(`handleMatchGroupInviteCancel: Failed to find group with invite ${info.requestId}`);
            return false;
        }

        const invite = group.invites.get(info.requestId);
        if (!invite) {
            this.logger.error(`handleMatchGroupInviteCancel: Failed to find invite ${info.requestId} in group`);
            return false;
        }

        if (!group.invites.delete(info.requestId)) {
            this.logger.error(`handleMatchGroupInviteCancel: Failed to remove invite ${info.requestId} from invites`);
            return false;
        }

        const senderProfile = this.getProfileByAID(invite.sender);
        const recipientProfile = this.getProfileByAID(invite.recipient);

        this.webSocketHandler.sendMessage(recipientProfile.info.id, {
            "type": "groupMatchInviteCancel",
            "eventId": "groupMatchInviteCancel",
            "aid": senderProfile.info.aid,
            "nickname": senderProfile.characters.pmc.Info.Nickname
        } as any);

        this.logger.info(`handleMatchGroupInviteCancel: Successfully canceled invite ${info.requestId} from ${invite.sender} to ${invite.recipient}`);

        return true;
    }

    /** Handle /client/match/group/invite/cancel-all */
    public handleMatchGroupInviteCancelAll(sessionID: string): boolean {
        const profile = this.saveServer.getProfile(sessionID);
        const aid = profile.info.aid;
        const group = this.groups.find(g => g.owner == aid);
        if (!group) {
            this.logger.error(`handleMatchGroupInviteCancelAll: Failed to get group where ${aid} is the owner`);
            return false;
        }

        for (const invite of Array.from(group.invites.values())) {
            const recipient = this.getProfileByAID(invite.recipient);
            if (!recipient) {
                continue;
            }

            this.webSocketHandler.sendMessage(recipient.info.id, {
                "type": "groupMatchInviteCancel",
                "eventId": "groupMatchInviteCancel",
                "aid": recipient.info.aid,
                "nickname": recipient.characters.pmc.Info.Nickname
            } as any);
        }

        for (const [_, member] of group.members) {
            this.webSocketHandler.sendMessage(member._id, {
                "type": "groupMatchUserLeave",
                "eventId": "groupMatchUserLeave",
                "aid": aid,
                "Nickname": member.Info.Nickname
            } as any);
        }

        return true;
    }

    /** Handle /client/match/group/invite/decline */
    public handleMatchGroupInviteDecline(info: IRequestIdRequest, sessionID: string): boolean {
        this.logger.warning(`handleMatchGroupInviteDecline: ${JSON.stringify(this.groups)}`);
        const group = this.groups.find(g => g.invites.has(info.requestId));
        if (!group) {
            this.logger.error(`handleMatchGroupInviteDecline: Failed to find group with invite ${info.requestId}`);
            return false;
        }

        const invite = group.invites.get(info.requestId);
        if (!invite) {
            this.logger.error(`handleMatchGroupInviteDecline: Failed to find invite ${info.requestId} in group`);
            return false;
        }

        if (!group.invites.delete(info.requestId)) {
            this.logger.error(`handleMatchGroupInviteDecline: Failed to remove invite ${info.requestId} from invites`);
            return false;
        }

        const recipientProfile = this.getProfileByAID(invite.recipient);
        const senderProfile = this.getProfileByAID(invite.sender);

        this.webSocketHandler.sendMessage(senderProfile.info.id, {
            "type": "groupMatchInviteDecline",
            "eventId": "groupMatchInviteDecline",
            "aid": recipientProfile.info.aid,
            "Nickname": recipientProfile.characters.pmc.Info.Nickname
        } as any);

        this.logger.info(`handleMatchGroupInviteDecline: Invite ${info.requestId} from ${invite.sender} to ${invite.recipient} declined successfully`);

        return true;
    }

    /** Handle /client/match/group/invite/send */
    public handleMatchGroupInviteSend(info: IMatchGroupInviteSendRequest, sessionID: string): string {
        const senderProfile = this.saveServer.getProfile(sessionID);
        const senderAid = senderProfile.info.aid;
        this.logger.info(`handleMatchGroupInviteSend: ${senderAid}->${info.to} ${(info.inLobby ? "in lobby" : "not in lobby")}`);
        let group = this.groups.find(g => g.owner === senderAid);
        if (!group) {
            this.logger.info("Does not own group, seeing if they are in one");
            group = this.groups.find(g => g.members.has(senderAid));
            if (!group) {
                this.logger.info("Is not in a group, creating a new one");
                group = new Group(senderAid);
                const character: IGroupCharacter = {
                    _id: senderProfile.info.id,
                    aid: senderProfile.info.aid,
                    Info: {
                        Nickname: senderProfile.characters.pmc.Info.Nickname,
                        Side: senderProfile.characters.pmc.Info.Side,
                        Level: senderProfile.characters.pmc.Info.Level,
                        MemberCategory: senderProfile.characters.pmc.Info.MemberCategory,
                        GameVersion: senderProfile.info.edition,
                        SavageLockTime: senderProfile.characters.scav.Info.SavageLockTime,
                        SavageNickname: senderProfile.characters.scav.Info.Nickname,
                        hasCoopExtension: true
                    },
                    isLeader: true
                };

                group.members.set(senderAid, character);
                this.groups.push(group);
            }
        }

        const recipientAid = Number.parseInt(info.to);
        const id = this.hashUtil.generate();
        const invite: IGroupInvite = {
            sender: senderAid,
            recipient: recipientAid
        };

        group.invites.set(id, invite);

        const recipientProfile = this.getProfileByAID(recipientAid);
        this.webSocketHandler.sendMessage(recipientProfile.info.id, {
            "type": "groupMatchInviteSend",
            "eventId": "groupMatchInviteSend",
            "requestId": id,
            "from": senderAid,
            "members": Array.from(group.members.values())
        } as any);

        this.logger.info(`handleMatchGroupInviteSend: Sent invite to ${info.to}`);
        this.logger.warning(`handleMatchGroupInviteSend: ${JSON.stringify(this.groups)}`);

        return id;
    }

    /** Handle /client/match/group/leave */
    public handleMatchGroupLeave(sessionID: string): boolean {
        const profileWhoLeft = this.saveServer.getProfile(sessionID);
        const aid = profileWhoLeft.info.aid;
        const group = this.groups.find(g => g.members.has(aid));
        if (!group) {
            this.logger.error(`handleMatchGroupLeave: ${aid} is not in a group`);
            return false;
        }

        if (!group.members.delete(aid)) {
            this.logger.error(`handleMatchGroupLeave: Failed to remove ${aid} from group members`);
            return false;
        }

        this.logger.info(`handleMatchGroupLeave: ${aid} left group owned by ${group.owner}`);

        for (const [_, character] of group.members) {
            this.webSocketHandler.sendMessage(character._id, {
                "type": "groupMatchUserLeave",
                "eventId": "groupMatchUserLeave",
                "aid": aid,
                "Nickname": profileWhoLeft.characters.pmc.Info.Nickname
            } as any);
        }

        if (group.members.size === 0) {
            this.logger.info(`handleMatchGroupLeave: Group owned by ${group.owner} is now empty, removing group`);
            this.groups = this.groups.filter(g => g !== group);
        }
        else if (aid === group.owner) {
            this.logger.info(`handleMatchGroupLeave: Owner ${aid} left group, reassigning ownership`);
            const newOwner = group.members.keys().next().value;
            group.owner = newOwner;
            const newLeader = group.members.get(newOwner);
            if (newLeader) {
                newLeader.isLeader = true;
            }

            this.logger.info(`handleMatchGroupLeave: New owner is ${newOwner}`);
        }

        return true;
    }

    /** Handle /client/match/group/looking/start */
    public handleMatchGroupLookingStart(sessionID: string): void {
        this.logger.warning("Default implementation of handleMatchGroupLookingStart");
    }

    /** Handle /client/match/group/looking/stop */
    public handleMatchGroupLookingStop(sessionID: string): void {
        this.logger.warning("Default implementation of handleMatchGroupLookingStop");
    }

    /** Handle /client/match/group/player/remove */
    public handleMatchGroupPlayerRemove(info: IMatchGroupPlayerRemoveRequest, sessionID: string): boolean {
        const aid = Number.parseInt(info.aidToKick);
        const group = this.groups.find(g => g.members.has(aid));
        if (!group) {
            this.logger.error(`handleMatchGroupPlayerRemove: ${sessionID} tried to kick ${aid} from group but they aren't even in one`);
            return false;
        }

        const userWhoLeft = group.members.get(aid);
        if (!group.members.delete(aid)) {
            this.logger.error(`handleMatchGroupPlayerRemove: Failed to remove ${aid} from members`);
            return false;
        }

        for (const [_, character] of group.members) {
            this.webSocketHandler.sendMessage(character._id, {
                "type": "groupMatchUserLeave",
                "eventId": "groupMatchUserLeave",
                "aid": aid,
                "Nickname": userWhoLeft.Info.Nickname
            } as any);
        }

        this.webSocketHandler.sendMessage(userWhoLeft._id, {
            "type": "groupMatchUserLeave",
            "eventId": "groupMatchUserLeave",
            "aid": aid,
            "Nickname": userWhoLeft.Info.Nickname
        } as any);

        return true;
    }

    /** Handle /client/match/group/start_game */
    public handleMatchGroupStartGame(info: IMatchGroupStartGameRequest, sessionID: string): IProfileStatusResponse {
        this.logger.warning("Default implementation of handleMatchGroupStartGame");
        return {
            maxPveCountExceeded: false,
            profiles: [
            ],
        };
    }

    /** Handle /client/match/group/status */
    public handleMatchGroupStatus(info: IMatchGroupStatusRequest, sessionID: string): IMatchGroupStatusResponse {
        this.logger.warning("Default implementation of handleMatchGroupStatus");
        const profile = this.saveServer.getProfile(sessionID);
        const group = this.groups.find(g => g.members.has(profile.info.aid));

        return {
            players: Array.from(group.members.values()),
            maxPveCountExceeded: false,
        };
    }

    /** Handle /client/match/group/transfer */
    public handleMatchGroupTransfer(info: IMatchGroupTransferRequest, sessionID: string): boolean {
        const thisPlayerAid = this.saveServer.getProfile(sessionID).info.aid;
        const thisPlayerGroup = this.groups.find(g => g.members.has(thisPlayerAid));
        if (!thisPlayerGroup) {
            this.logger.error(`handleMatchGroupTransfer: ${thisPlayerAid} is not in a group but tried to transfer leadership`);

            return false;
        }

        const newOwnerAid = Number.parseInt(info.aidToChange);
        thisPlayerGroup.owner = newOwnerAid;
        thisPlayerGroup.members.get(newOwnerAid).isLeader = true;
        thisPlayerGroup.members.get(thisPlayerAid).isLeader = false;

        for (const [_, member] of thisPlayerGroup.members) {
            this.webSocketHandler.sendMessage(member._id, {
                type: "groupMatchLeaderChanged",
                eventId: "groupMatchLeaderChanged",
                owner: newOwnerAid
            } as any);
        }

        this.logger.info(`handleMatchGroupTransfer: Changed leader from ${thisPlayerAid}->${newOwnerAid}`);

        return true;
    }

    /** Handle /client/profile/status */
    public handleProfileStatus(info: IProfileStatusRequest, sessionID: string): IProfileStatusResponse {
        this.logger.warning("Default implementation of handleProfileStatus");
        return {
            maxPveCountExceeded: false,
            profiles: [
                // requesting player's
                // - scav
                // - pmc
            ],
        };
    }

    /** Handle /client/match/raid/ready */
    public handleRaidReady(info: IEmptyRequestData, sessionID: string): boolean {
        const profile = this.saveServer.getProfile(sessionID);
        this.logger.warning(`handleRaidReady: ${JSON.stringify(this.groups)}`);
        const group = this.groups.find(g => g.members.has(profile.info.aid));
        if (!group) {
            this.logger.error(`handleRaidReady: ${profile.info.aid} set to ready but is not in a group`);

            return false;
        }

        const thisMember = group.members.get(profile.info.aid);
        thisMember.isReady = true;
        for (const [_, member] of group.members) {
            this.webSocketHandler.sendMessage(member._id, {
                type: "groupMatchRaidReady",
                eventId: "groupMatchRaidReady",
                extendedProfile: thisMember
            } as any);
        }

        this.logger.info(`handleRaidReady: ${profile.info.aid} set status to ready`);

        return true;
    }

    /** Handle /client/match/raid/not-ready */
    public handleNotRaidReady(info: IEmptyRequestData, sessionID: string): boolean {
        const profile = this.saveServer.getProfile(sessionID);
        const group = this.groups.find(g => g.members.has(profile.info.aid));
        if (!group) {
            this.logger.error(`handleNotRaidReady: ${profile.info.aid} set to not-ready but is not in a group`);

            return false;
        }

        const thisMember = group.members.get(profile.info.aid);
        thisMember.isReady = false;

        for (const [_, member] of group.members) {
            this.webSocketHandler.sendMessage(member._id, {
                type: "groupMatchRaidNotReady",
                eventId: "groupMatchRaidNotReady",
                extendedProfile: thisMember
            } as any);
        }

        this.logger.info(`handleNotRaidReady: ${profile.info.aid} set status to not-ready`);

        return true;
    }
}
