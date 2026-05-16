// Docs: https://www.instantdb.com/docs/modeling-data

import { i } from "@instantdb/svelte";

const _schema = i.schema({
  entities: {
    $files: i.entity({
      path: i.string().unique().indexed(),
      url: i.string(),
    }),
    $streams: i.entity({
      abortReason: i.string().optional(),
      clientId: i.string().unique().indexed(),
      done: i.boolean().optional(),
      size: i.number().optional(),
    }),
    $users: i.entity({
      email: i.string().unique().indexed().optional(),
      imageURL: i.string().optional(),
      type: i.string().optional(),
    }),
    attachments: i.entity({
      cloudId: i.string().optional(),
      contentType: i.string().optional(),
      createdAt: i.date().indexed(),
      height: i.number().optional(),
      preview: i.string().optional(),
      resourceType: i.string().optional(),
      url: i.string(),
      width: i.number().optional(),
    }),
    messages: i.entity({
      author: i.string(),
      authorId: i.string().optional(),
      createdAt: i.date().indexed(),
      editedAt: i.date().optional(),
      text: i.string(),
    }),
    profiles: i.entity({
      createdAt: i.date(),
      nickname: i.string().indexed(),
      userId: i.string().indexed().optional(),
    }),
    rooms: i.entity({
      createdAt: i.date(),
      createdBy: i.string().optional(),
      createdById: i.string().optional(),
      kind: i.string().optional(),
      name: i.string().unique().indexed(),
    }),
  },
  links: {
    $streams$files: {
      forward: {
        on: "$streams",
        has: "many",
        label: "$files",
      },
      reverse: {
        on: "$files",
        has: "one",
        label: "$stream",
        onDelete: "cascade",
      },
    },
    $usersLinkedPrimaryUser: {
      forward: {
        on: "$users",
        has: "one",
        label: "linkedPrimaryUser",
        onDelete: "cascade",
      },
      reverse: {
        on: "$users",
        has: "many",
        label: "linkedGuestUsers",
      },
    },
    messagesMedia: {
      forward: {
        on: "messages",
        has: "many",
        label: "media",
      },
      reverse: {
        on: "attachments",
        has: "many",
        label: "messages",
      },
    },
    messagesReplyTo: {
      forward: {
        on: "messages",
        has: "one",
        label: "replyTo",
      },
      reverse: {
        on: "messages",
        has: "many",
        label: "replies",
      },
    },
    messagesRoom: {
      forward: {
        on: "messages",
        has: "one",
        label: "room",
        onDelete: "cascade",
      },
      reverse: {
        on: "rooms",
        has: "many",
        label: "messages",
      },
    },
    profilesUser: {
      forward: {
        on: "profiles",
        has: "one",
        label: "user",
        onDelete: "cascade",
      },
      reverse: {
        on: "$users",
        has: "one",
        label: "profile",
      },
    },
    // DM membership link — rooms → profiles. Replaces the original
    // roomsParticipants link (which targeted $users); that one should be
    // deleted via the InstantDB dashboard since CLI push won't remove it.
    roomsMembers: {
      forward: {
        on: "rooms",
        has: "many",
        label: "members",
      },
      reverse: {
        on: "profiles",
        has: "many",
        label: "memberOfRooms",
      },
    },
  },
  rooms: {
    lobby: {
      presence: i.entity({
        currentRoomId: i.string().optional(),
        nickname: i.string(),
        userId: i.string(),
      }),
    },
  },
});

// This helps TypeScript display nicer intellisense
type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
