import type { Message, MessageAttachment, EditAction, DeleteAction, RegenerateAction, BranchLabel } from '$lib/types/chat';
import type { LLMMessage } from '$lib/types/llm';
import { db } from '$lib/services/database';
import { chatStore } from './chat.svelte';
import { toastStore } from './toast.svelte';
import { llmService } from '$lib/services/llm/provider';
import { findActivePath, findDeepestLeafFromNode } from '$lib/utils/message-tree';
import { buildPromptMessages, type BuiltPrompt } from '$lib/utils/prompt-builder';
import { joinContinuation } from '$lib/utils/continuation';
import { featurePromptsStore } from '$lib/stores/featurePrompts.svelte';
import { personaStore } from './persona.svelte';
import { chatCastStore } from './chatCast.svelte';
import { resolveMacroValues, substitute } from '$lib/macros';
import { buildLiveMacroContext } from '$lib/utils/live-macro-context';
import { memoryStore } from '$lib/memory/store.svelte';
import { spriteStore } from './sprites.svelte';
import { steeringStore } from './steering.svelte';
import { steeringTargetForChat } from '$lib/types/steering';
import type { LorebookTrigger } from '$lib/lorebook/types';
import { countMessages, tokenCalibration } from '$lib/tokenizer';

class MessageStore {
	abortController = $state<AbortController | null>(null);
	private isProcessing = $state(false);

	/** A generation is in flight ANYWHERE, not merely in the chat on screen: walking into
	 *  another chat must not read as idle and let a second generation start beside the
	 *  first, since both would share the one abort controller below. */
	isStreaming = $derived(chatStore.stream !== null);

	/** True (with a toast) while a generation or another tree mutation is in flight.
	 *  Edits, deletes, branching and branch navigation must wait: running them mid-stream
	 *  can fork the lineage the streaming turn is about to attach to, delete its parent,
	 *  or start a second concurrent generation over the same streaming state. Public so UI
	 *  surfaces can ask BEFORE tearing down their own state (e.g. closing an editor whose
	 *  draft would otherwise be lost to a rejected call). */
	warnIfBusy(): boolean {
		if (this.isProcessing || this.isStreaming) {
			toastStore.warning('A reply is still generating. Wait for it, or stop it first.');
			return true;
		}
		return false;
	}

	async sendMessage(content: string, attachments?: MessageAttachment[]): Promise<void> {
		if (this.isProcessing) return;
		this.isProcessing = true;

		try {
			const state = chatStore.currentChatState;
			if (!state) throw new Error('No active chat');

			const userMessage = await this.createMessage({
				chatId: state.chat.id,
				parentId: state.chat.activeLeafId,
				role: 'user',
				content,
				attachments: attachments?.length ? attachments : null,
				// The active leaf usually has no children, but after a cancelled "alternate"
				// regenerate it can, so never collide with an existing sibling index.
				siblingIndex: await db.getNextSiblingIndex(state.chat.id, state.chat.activeLeafId)
			});

			// Update active leaf and root if needed
			if (!state.chat.rootMessageId) {
				await db.updateChat(
					{
						id: state.chat.id,
						rootMessageId: userMessage.id,
						activeLeafId: userMessage.id
					},
					{ touchUpdatedAt: true }
				);
			} else {
				await db.updateChatActiveLeaf(state.chat.id, userMessage.id, { touchUpdatedAt: true });
			}

			await chatStore.refreshChat(state.chat.id);

			// Generate LLM response
			await this.generateResponse(state.chat.id, userMessage.id);
		} catch (error) {
			if (error instanceof Error && error.name !== 'AbortError') {
				toastStore.failed('generate the reply', error);
			}
		} finally {
			this.isProcessing = false;
		}
	}

	/** Generate an assistant reply under `parentId`. Resolves to the new message's id, or to
	 *  null when nothing was streamed to keep (no message is created). A stop mid-stream still
	 *  persists what streamed, so it returns an id like any other reply. Other failures throw. */
	async generateResponse(
		chatId: string,
		parentId: string,
		lorebookTrigger: LorebookTrigger = 'normal'
	): Promise<string | null> {
		this.abortController = new AbortController();
		chatStore.startStream(chatId);

		try {
			// Commit any steering-note edit still sitting in its debounce window: the
			// prompt builder reads the note rows from the db, not the store's copy.
			await steeringStore.flush();
			const { messages, lorebook, oneShotSteering } = await this.buildMessageHistory(
				chatId,
				parentId,
				lorebookTrigger
			);

			// The turn is written by the SERVER, from this placement, the moment the model
			// stops: the generation outlives this page, and a phone whose tab is discarded
			// mid-reply would otherwise have nowhere to put the answer it paid for. The leaf
			// is named as it stands now, so a commit that lands after the reader walked to
			// another branch leaves them where they are (architecture/chat-sessions.md).
			const result = await llmService.complete('primary', {
				messages,
				source: 'chat',
				onToken: (token) => {
					chatStore.appendStreamingContent(token);
				},
				onThinkingToken: (token) => {
					chatStore.appendStreamingThinking(token);
				},
				signal: this.abortController.signal,
				commit: {
					chatId,
					parentId,
					expectedLeafId: parentId,
					claimsRoot: false,
					lorebook,
					spendSteeringIds: oneShotSteering.map((note) => note.id)
				}
			});

			// A stop mid-stream comes back as a normal result carrying everything that
			// streamed before it, and that text is persisted as the turn like any other
			// reply. The user watched it arrive and stopped because they had enough.
			// Only a stop before the first token has nothing to keep, which the commit
			// refuses on the same rule and reports back as no row at all.
			if (!result.committedMessageId) return null;

			// Teach the per-model token calibration from the provider's real prompt_tokens.
			tokenCalibration.record(result.model, countMessages(messages, result.model), result.usage.promptTokens);

			await chatStore.refreshChat(chatId);

			// The notes themselves were spent inside the commit, so nothing here can leave
			// guidance armed to apply itself twice. What is left is the chat's own reuse
			// list, which is per-chat state the server deliberately does not author.
			await chatStore.pushSteeringHistory(chatId, oneShotSteering.map((note) => note.text));

			// Fire the memory sidecar in background (don't await).
			this.triggerMemoryMaintenance(chatId);
			return result.committedMessageId;
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				// A stop the server never answered (dead socket, or it aborted before the
				// stream opened): nothing streamed, nothing to keep.
				return null;
			}
			// The turn is the server's to write, so a break on this side says nothing about
			// whether one landed: a generation that finished before the connection was lost
			// is already in the chat. Re-read before surfacing the failure, or the reply sits
			// there unseen until something else happens to refresh.
			await chatStore.refreshChat(chatId);
			throw error;
		} finally {
			chatStore.endStream();
			this.abortController = null;
		}
	}

	async editMessage(
		messageId: string,
		newContent: string,
		action: EditAction,
		opts: { minor?: boolean } = {}
	): Promise<void> {
		if (this.warnIfBusy()) return;
		const state = chatStore.currentChatState;
		if (!state) throw new Error('No active chat');

		// Look the message up across the whole tree, not just the active path, so the story map
		// can edit off-path branch nodes too. The chat only ever passes active-path ids, so its
		// behaviour is unchanged (same object, same code path). `save_only` leaves the active leaf
		// alone; `create_branch` moves it onto the fork it just wrote, exactly as in chat.
		const message = state.allMessages.find((m) => m.id === messageId);
		if (!message) throw new Error('Message not found');

		// An in-place rewrite keeps the id, so the summary covering it now describes text that
		// is gone. Coverage resolution catches that on its own (the row's `edited_at` outdates
		// the episode), but the toast has to be truthful in the same tick, so the rewrite is
		// handed over explicitly. Gated on the per-chat flag alone (not the app-wide engine
		// switch), so stored memory never goes stale during an off period. create_branch is
		// exempt: the clone is a new id, and the original's summary stays valid for it. So is a
		// MINOR edit: the user has asserted the turn still says the same thing, so the write
		// leaves `edited_at` alone and nothing here may drop the summary either. It is their
		// assertion, not ours: a typo and a retcon are the same two strings to us.
		const rewritesArchived = action !== 'create_branch' && !opts.minor && memoryStore.enabled;
		// The same staleness question, asked of the character's face. Same exemption for a
		// MINOR save, and off by default because a re-read is a second call on a turn the
		// user already paid for.
		const rereadsSprite =
			action !== 'create_branch' && !opts.minor && featurePromptsStore.spritesRereadOnEdit;

		this.isProcessing = true;
		try {
			switch (action) {
				case 'save_only':
					await db.updateMessageContent(messageId, newContent, { minor: opts.minor });
					await db.touchChatActivity(state.chat.id);
					if (rewritesArchived) await this.invalidateMemoryFor(state.chat.id, messageId);
					if (rereadsSprite) await this.invalidateSpriteFor(messageId);
					break;

				case 'create_branch': {
					const nextSiblingIndex = await db.getNextSiblingIndex(state.chat.id, message.parentId);
					const newMessage = await this.createMessage({
						chatId: state.chat.id,
						parentId: message.parentId,
						role: message.role,
						content: newContent,
						personaId: message.personaId,
						attachments: message.attachments,
						siblingIndex: nextSiblingIndex
					});

					// The fork becomes the branch being read, and nothing is generated: the user
					// asked for a fork, not for a turn. On a user branch that leaves the new turn
					// as the leaf, so Generate is right there when they want it: deliberate
					// breathing room instead of a call they never asked to spend.
					await db.updateChatActiveLeaf(state.chat.id, newMessage.id, { touchUpdatedAt: true });
					break;
				}
			}

			await chatStore.refreshCurrentChat();
		} catch (error) {
			if (error instanceof Error && error.name !== 'AbortError') {
				toastStore.failed('save the edit', error);
			}
			await chatStore.refreshCurrentChat();
		} finally {
			this.isProcessing = false;
		}
	}

	/** Drop the summary covering a rewritten turn, before this call returns, so the toast is
	 *  truthful. Failures are surfaced but never block the edit: the content is saved. */
	private async invalidateMemoryFor(chatId: string, messageId: string): Promise<void> {
		try {
			const dropped = await memoryStore.invalidateMessage(chatId, messageId);
			if (dropped) toastStore.info("This turn's summary was discarded. It will be re-read on the next pass.");
		} catch (e) {
			console.error('[memory] invalidate after archived edit failed:', e);
			toastStore.failed('update memory for this edit', e);
		}
	}

	/** Drop the sprite reading over a rewritten turn so the engine reads it again. Never
	 *  blocks the edit: the content is saved either way, and a face is presentation. */
	private async invalidateSpriteFor(messageId: string): Promise<void> {
		try {
			await spriteStore.invalidateMessage(messageId);
		} catch (e) {
			console.error('[sprites] invalidate after edit failed:', e);
			toastStore.failed('re-read the sprite for this turn', e);
		}
	}

	async deleteMessage(messageId: string, action: DeleteAction): Promise<void> {
		if (this.warnIfBusy()) return;
		const state = chatStore.currentChatState;
		if (!state) throw new Error('No active chat');

		// Tree-wide lookup so the story map can prune off-path branches. The active-leaf
		// navigation below is gated on whether the deletion actually touches the branch we're
		// viewing, so pruning an off-path branch never yanks the current view. The chat only
		// deletes active-path messages, so it keeps its exact prior behaviour.
		const message = state.allMessages.find((m) => m.id === messageId);
		if (!message) throw new Error('Message not found');

		this.isProcessing = true;
		try {
			if (action === 'this_only') {
				// Splice: only this row goes; its children re-parent to its parent and every
				// subtree below survives.
				const allMessages = await db.getMessagesByChat(state.chat.id);
				const children = allMessages
					.filter((m) => m.parentId === messageId)
					.sort((a, b) => a.siblingIndex - b.siblingIndex);
				const isActiveLeaf = state.chat.activeLeafId === messageId;

				// Re-parent children to this message's parent, then delete just this message
				await db.deleteMessageOnly(messageId);
				const after = await db.getMessagesByChat(state.chat.id);

				// If we deleted the root, update to new root (first surviving parentless row)
				if (state.chat.rootMessageId === messageId) {
					const newRoot = after
						.filter((m) => m.parentId === null)
						.sort((a, b) => a.siblingIndex - b.siblingIndex)[0];
					await db.updateChat({
						id: state.chat.id,
						rootMessageId: newRoot?.id ?? null
					});
				}

				// The view needs re-homing ONLY when the deleted turn was the leaf itself. A
				// mid-path splice leaves the leaf alive (the path simply re-forms around the
				// removed turn) and an off-path prune never touches the view, so in both
				// cases the user stays exactly where they were reading.
				let newLeafId = state.chat.activeLeafId;
				if (isActiveLeaf) {
					// Land on the nearest sibling branch, preferring a same-role variant when
					// one exists (continuity) and taking any fork otherwise; else follow the
					// re-parented children, else fall back to the parent.
					const pool = allMessages
						.filter((m) => m.parentId === message.parentId && m.id !== messageId)
						.sort((a, b) => a.siblingIndex - b.siblingIndex);
					const sameRole = pool.filter((m) => m.role === message.role);
					const candidates = sameRole.length > 0 ? sameRole : pool;
					if (candidates.length > 0) {
						const deletedIndex = message.siblingIndex ?? 0;
						const nextSibling = candidates.find((s) => s.siblingIndex > deletedIndex);
						const prevSibling = [...candidates].reverse().find((s) => s.siblingIndex < deletedIndex);
						const targetSibling = nextSibling ?? prevSibling ?? candidates[0];
						newLeafId = findDeepestLeafFromNode(after, targetSibling.id);
					} else if (children.length > 0) {
						newLeafId = findDeepestLeafFromNode(after, children[0].id);
					} else {
						newLeafId = message.parentId;
					}
					await db.updateChatActiveLeaf(state.chat.id, newLeafId, { touchUpdatedAt: true });
				} else {
					await db.touchChatActivity(state.chat.id);
				}

				// Splice honesty: re-parented children that ended up off the viewed path are
				// easy to mistake for deleted, so say where they went instead of going silent.
				if (children.length > 0) {
					const onPath = newLeafId ? new Set(findActivePath(after, newLeafId).map((m) => m.id)) : new Set<string>();
					if (!children.some((c) => onPath.has(c.id))) {
						toastStore.info(
							children.length === 1
								? 'The reply below was kept. It now follows the previous turn as its own branch, reachable by swiping there or from the story map.'
								: 'The replies below were kept. They now follow the previous turn as their own branches, reachable by swiping there or from the story map.'
						);
					}
				}
			} else {
				// Delete message and all descendants
				const parentId = message.parentId;

				// Remaining sibling branches before deletion: prefer a same-role variant
				// for continuity, else any fork (all branches are navigable now).
				const allMessages = await db.getMessagesByChat(state.chat.id);
				const pool = allMessages
					.filter((m) => m.parentId === parentId && m.id !== messageId)
					.sort((a, b) => a.siblingIndex - b.siblingIndex);
				const sameRole = pool.filter((m) => m.role === message.role);
				const siblings = sameRole.length > 0 ? sameRole : pool;

				// Only re-home the active leaf if the branch we're deleting is the one we're viewing.
				// An off-path prune (from the story map) leaves the current view untouched.
				const isInActivePath = state.chat.activeLeafId
					? findActivePath(allMessages, state.chat.activeLeafId).some((m) => m.id === messageId)
					: false;

				// The confirm dialog already stated the blast radius. This is final: rows
				// and their attachment files go together.
				await db.deleteMessageAndDescendants(messageId);

				if (isInActivePath) {
					// Navigate to a remaining sibling if one exists, otherwise go to parent
					let newLeafId: string | null;
					if (siblings.length > 0) {
						// Find the sibling closest to the deleted one's position
						const deletedIndex = message.siblingIndex ?? 0;
						const nextSibling = siblings.find((s) => s.siblingIndex > deletedIndex);
						const prevSibling = [...siblings].reverse().find((s) => s.siblingIndex < deletedIndex);
						const targetSibling = nextSibling ?? prevSibling ?? siblings[0];

						const messagesAfterDelete = await db.getMessagesByChat(state.chat.id);
						newLeafId = findDeepestLeafFromNode(messagesAfterDelete, targetSibling.id);

						// Verify the sibling still exists
						if (!messagesAfterDelete.some((m) => m.id === targetSibling.id)) {
							newLeafId = parentId;
						}
					} else {
						newLeafId = parentId;
					}

					await db.updateChatActiveLeaf(state.chat.id, newLeafId, { touchUpdatedAt: true });
				} else {
					// Off-path prune: keep the active leaf where it is, just bump activity.
					await db.touchChatActivity(state.chat.id);
				}

				// If we deleted the root, find a surviving root sibling
				if (state.chat.rootMessageId === messageId) {
					const remaining = await db.getMessagesByChat(state.chat.id);
					const newRoot = remaining
						.filter((m) => m.parentId === null)
						.sort((a, b) => a.siblingIndex - b.siblingIndex)[0];
					await db.updateChat({
						id: state.chat.id,
						rootMessageId: newRoot?.id ?? null
					});
				}
			}

			// A canon marker inside the removed subtree would dangle silently, so retreat it.
			await this.repairCanon(state.chat.id, state.allMessages);
			await chatStore.refreshCurrentChat();
		} finally {
			this.isProcessing = false;
		}
	}

	/**
	 * After a structural delete, a canonLeafId pointing at a removed message would dangle
	 * forever (the gold spine silently vanishes from the story map). Retreat it to its
	 * nearest surviving ancestor (the canonical prefix that still exists) or clear it.
	 */
	private async repairCanon(chatId: string, preMessages: Message[]): Promise<void> {
		const chat = await db.getChat(chatId);
		if (!chat?.canonLeafId) return;
		const post = await db.getMessagesByChat(chatId);
		const alive = new Set(post.map((m) => m.id));
		if (alive.has(chat.canonLeafId)) return;
		const byId = new Map(preMessages.map((m) => [m.id, m]));
		let cur = byId.get(chat.canonLeafId)?.parentId ?? null;
		while (cur && !alive.has(cur)) cur = byId.get(cur)?.parentId ?? null;
		await db.updateChat({ id: chatId, canonLeafId: cur }, { touchUpdatedAt: false });
	}

	/** The turn a jump wants brought into view, set beside a navigation and claimed by the
	 *  transcript, which scrolls to it, marks it briefly and clears this back to null.
	 *  Navigating reaches a BRANCH, by its deepest leaf, which is rarely the turn the user
	 *  picked. Without naming it they arrive in another timeline at whatever scroll offset
	 *  the previous one had, with nothing on screen saying where the turn they chose went. */
	revealTargetId = $state<string | null>(null);

	/** The turn whose editor should open in Branch mode, set by `/branch` and claimed by the
	 *  transcript row, which opens its editor and clears this back to null. Same one-shot
	 *  idiom as `revealTargetId`, and for the same reason: the editor is the row's own state,
	 *  so the composer can only ask for it, never reach in and set it. */
	branchTargetId = $state<string | null>(null);

	/** Point the transcript at a turn from anywhere else in the app (the assistant's timeline
	 *  rows and approval cards; the story map sets `revealTargetId` directly, since it has
	 *  already navigated). The branch switch happens only when the turn is OFF the path being
	 *  read: navigating to one already on it re-homes the leaf onto whatever hangs deepest
	 *  below it, which is a different timeline. Everything after that is the transcript's:
	 *  it loads the turn back into the window if it sits behind it, then plays the flash. */
	async revealMessage(messageId: string): Promise<void> {
		const onPath = chatStore.currentChatState?.activePath.some((m) => m.id === messageId) ?? false;
		if (!onPath) {
			try {
				await this.navigateToBranch(messageId);
			} catch {
				/* not in this chat / not navigable, best effort */
			}
		}
		this.revealTargetId = messageId;
	}

	async navigateToBranch(messageId: string): Promise<void> {
		if (this.warnIfBusy()) return;
		const state = chatStore.currentChatState;
		if (!state) throw new Error('No active chat');

		// Find the deepest leaf starting from this message
		const messages = await db.getMessagesByChat(state.chat.id);

		// Validate message exists (might be stale reference from UI race condition)
		const messageExists = messages.some((m) => m.id === messageId);
		if (!messageExists) {
			// Message was deleted, just refresh to sync UI
			await chatStore.refreshCurrentChat();
			return;
		}

		const leafId = findDeepestLeafFromNode(messages, messageId);

		await db.updateChatActiveLeaf(state.chat.id, leafId, { touchUpdatedAt: false });
		await chatStore.refreshCurrentChat();
	}

	/** Name (or clear, with null) the branch a message heads: story-map metadata only.
	 *  Never touches content or edited_at, and doesn't reorder the chat. */
	async setBranchLabel(messageId: string, label: BranchLabel | null): Promise<void> {
		await db.updateMessageBranchLabel(messageId, label);
		await chatStore.refreshCurrentChat();
	}

	/** Re-attribute every user turn in a chat to `personaId` (or clear with null so they
	 *  read as a plain "You"). A deliberate after-the-fact rebind for imported/legacy chats
	 *  whose user messages carry no persona, distinct from the per-message lock at send time. */
	async setChatPersona(chatId: string, personaId: string | null): Promise<void> {
		await db.setChatUserPersona(chatId, personaId);
		await chatStore.refreshCurrentChat();
	}

	async navigateToSibling(messageId: string, direction: 'prev' | 'next'): Promise<void> {
		if (this.warnIfBusy()) return;
		const state = chatStore.currentChatState;
		if (!state) throw new Error('No active chat');

		// Fetch fresh data to avoid stale reference issues
		const messages = await db.getMessagesByChat(state.chat.id);
		const message = messages.find((m) => m.id === messageId);

		if (!message) {
			// Message was deleted, just refresh
			await chatStore.refreshCurrentChat();
			return;
		}

		// Fresh siblings, every role: the arrows walk all branches at this point, forks
		// included, mirroring findSiblings/the story map (see architecture/chat-sessions.md).
		const siblings = messages
			.filter((m) => m.parentId === message.parentId)
			.sort((a, b) => a.siblingIndex - b.siblingIndex);

		const currentIndex = siblings.findIndex((m) => m.id === messageId);
		const targetIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1;
		const targetSibling = siblings[targetIndex];

		if (!targetSibling) {
			// No sibling in that direction, just refresh
			await chatStore.refreshCurrentChat();
			return;
		}

		const leafId = findDeepestLeafFromNode(messages, targetSibling.id);
		await db.updateChatActiveLeaf(state.chat.id, leafId, { touchUpdatedAt: false });
		await chatStore.refreshCurrentChat();
	}

	async retryMessageResponse(messageId: string, action: RegenerateAction = 'replace'): Promise<void> {
		if (this.isProcessing) return;
		this.isProcessing = true;

		try {
			const state = chatStore.currentChatState;
			if (!state || state.activePath.length === 0) return;

			const message = state.activePath.find((m) => m.id === messageId);
			if (!message) throw new Error('Message not found in active path');

			if (message.role === 'assistant') {
				const parentId = message.parentId;
				if (!parentId) {
					throw new Error('Cannot regenerate: assistant message has no parent');
				}
				const prevLeafId = state.chat.activeLeafId;

				if (action === 'replace') {
					// Delete this response branch and regenerate from its parent user message
					await db.deleteMessageAndDescendants(message.id);
					await db.updateChatActiveLeaf(state.chat.id, parentId, { touchUpdatedAt: true });
					await this.repairCanon(state.chat.id, state.allMessages);
				} else {
					// Keep current branch and generate a new assistant sibling
					await db.updateChatActiveLeaf(state.chat.id, parentId, { touchUpdatedAt: false });
				}

				await chatStore.refreshCurrentChat();
				let newId: string | null = null;
				try {
					newId = await this.generateResponse(state.chat.id, parentId, 'swipe');
				} finally {
					// Aborted or failed: don't strand the view on the bare parent (the reply the
					// user was reading would just vanish). 'branch' restores that exact reply;
					// 'replace' (it's gone) lands on the nearest surviving swipe, else the parent.
					if (!newId) {
						const restoreId =
							action === 'branch' && prevLeafId
								? prevLeafId
								: findDeepestLeafFromNode(await db.getMessagesByChat(state.chat.id), parentId);
						await db.updateChatActiveLeaf(state.chat.id, restoreId, { touchUpdatedAt: false });
						await chatStore.refreshCurrentChat();
					}
				}
				return;
			}

			if (message.role === 'user') {
				// Re-roll the AI's answer to THIS turn: the user message is never cloned (that's
				// what the Branch action does). Mirrors the assistant path: replace nukes the replies
				// below and regenerates one; alternate keeps them and adds a swipeable assistant sibling.
				const prevLeafId = state.chat.activeLeafId;
				if (action === 'replace') {
					await db.deleteDescendants(message.id);
					await db.updateChatActiveLeaf(state.chat.id, message.id, { touchUpdatedAt: true });
					await this.repairCanon(state.chat.id, state.allMessages);
				} else {
					await db.updateChatActiveLeaf(state.chat.id, message.id, { touchUpdatedAt: false });
				}
				await chatStore.refreshCurrentChat();
				let newId: string | null = null;
				try {
					newId = await this.generateResponse(state.chat.id, message.id, 'swipe');
				} finally {
					// Same restore as above; after 'replace' the user turn itself is the right
					// place to stand (its subtree is gone), so only 'branch' needs the old leaf.
					if (!newId && action === 'branch' && prevLeafId && prevLeafId !== message.id) {
						await db.updateChatActiveLeaf(state.chat.id, prevLeafId, { touchUpdatedAt: false });
						await chatStore.refreshCurrentChat();
					}
				}
				return;
			}

			throw new Error('Retry is only available for user and assistant messages');
		} catch (error) {
			if (error instanceof Error && error.name !== 'AbortError') {
				toastStore.failed('generate the new reply', error);
			}
		} finally {
			this.isProcessing = false;
		}
	}

	async regenerateLastResponse(action: RegenerateAction = 'replace'): Promise<void> {
		const state = chatStore.currentChatState;
		if (!state || state.activePath.length === 0) return;

		const lastMessage = state.activePath[state.activePath.length - 1];
		await this.retryMessageResponse(lastMessage.id, action);
	}

	cancelGeneration(): void {
		this.abortController?.abort();
	}

	/**
	 * Extend the newest assistant reply in place: rebuild the prompt that would regenerate
	 * it (the path up to its parent), append the reply so far as a trailing assistant turn
	 * plus the preset's continuation instruction, and stream the continuation into the
	 * existing bubble. On success the joined text and accumulated stats are written to the
	 * same row (never stamped as edited); a stop mid-stream keeps the tail that streamed and
	 * joins it like any other continuation, and a stop before the first token touches nothing.
	 */
	async continueMessage(): Promise<void> {
		if (this.isProcessing) return;
		const state = chatStore.currentChatState;
		if (!state) throw new Error('No active chat');
		const leaf = state.activePath[state.activePath.length - 1];
		if (!leaf || leaf.role !== 'assistant') {
			toastStore.warning('Continue needs the newest turn to be an AI reply');
			return;
		}

		this.isProcessing = true;
		this.abortController = new AbortController();
		chatStore.startStream(state.chat.id, { continuingMessageId: leaf.id });

		try {
			// Fresh rows, never the state snapshot: the standing rule for long operations.
			const allMessages = await db.getMessagesByChat(state.chat.id);
			const target = allMessages.find((m) => m.id === leaf.id);
			if (!target) throw new Error('The reply to continue no longer exists.');

			// The same prompt that generated the reply (its parent path), with the reply
			// itself riding as the assembly's continuation tail. A root reply (greeting /
			// opening scene) continues against an empty path.
			const path = target.parentId ? findActivePath(allMessages, target.parentId) : [];

			// Same steering flush as generateResponse: the prompt builder reads the db rows.
			await steeringStore.flush();
			// The primary connection, exactly like a send or a regenerate: a continuation is
			// the same story turn, only picked up mid-sentence. The instruction that follows
			// the reply is the preset's `continuePrompt`, resolved inside assembly.
			// The trace this build produces is deliberately dropped: the turn already carries the
			// record of the scan that opened it, and a continuation is a second scan whose result
			// never shaped the text already on screen.
			const { messages, continuationSent } = await buildPromptMessages({
				chatId: state.chat.id,
				chatMessages: path,
				continuation: target,
				lorebookTrigger: 'continue'
			});

			// Same clock as generateResponse: the LLM call alone, no db awaits.
			const startedAt = performance.now();
			const result = await llmService.complete('primary', {
				messages,
				source: 'continue',
				onToken: (token) => {
					chatStore.appendStreamingContent(token);
				},
				onThinkingToken: (token) => {
					chatStore.appendStreamingThinking(token);
				},
				signal: this.abortController.signal
			});
			const generationMs = Math.round(performance.now() - startedAt);

			// Teach the per-model token calibration from the provider's real prompt_tokens.
			tokenCalibration.record(result.model, countMessages(messages, result.model), result.usage.promptTokens);

			if (!result.content.trim()) {
				// A stop before the first token is the user's own doing, not a model that
				// answered with nothing: same fall-back-to-abort as generateResponse.
				if (result.finishReason !== 'cancelled') toastStore.warning('The model returned no continuation text');
				return;
			}
			// The anchor is the turn's text as the model received it (self-refs expanded, prompt
			// regex applied), so a restatement of a macro-laden greeting is still caught.
			const joined = joinContinuation(target.content, result.content, continuationSent);
			if (joined === target.content) {
				toastStore.warning('The model only restated the existing reply, so nothing was added');
				return;
			}

			await db.applyMessageContinuation(target.id, {
				content: joined,
				thinking: result.thinking
					? target.thinking
						? target.thinking + '\n\n' + result.thinking
						: result.thinking
					: target.thinking,
				tokensPrompt: result.usage.promptTokens,
				tokensCompletion: (target.tokensCompletion ?? 0) + result.usage.completionTokens,
				finishReason: result.finishReason,
				generationMs: (target.generationMs ?? 0) + generationMs,
				// Accumulated like generationMs, and for the same reason: a continuation is more
				// of this turn's cost, not a second turn. Null only while neither run measured
				// any, so a reasoning-free turn never claims a measured zero. `firstTokenMs` is
				// deliberately not here: the turn started speaking once, on the original run.
				reasoningMs:
					target.reasoningMs === null && result.reasoningMs === null
						? null
						: (target.reasoningMs ?? 0) + (result.reasoningMs ?? 0)
			});
			await db.touchChatActivity(state.chat.id);

			// In-place rewrite contract (same as editMessage): archived turns hand the
			// rewrite to memory. No-op for live turns, and the leaf is virtually always live.
			if (memoryStore.enabled) await this.invalidateMemoryFor(state.chat.id, target.id);
			// The turn ends somewhere else now, which is the only thing a sprite reading
			// was ever about. But re-reading it is a second call, so it is the user's setting.
			if (featurePromptsStore.spritesRereadOnContinue) {
				await this.invalidateSpriteFor(target.id);
			}

			await chatStore.refreshChat(state.chat.id);

			// Steering rode this continuation. It is spent only here, after the persisted write,
			// never on the two soft no-op returns above: no steered output landed there, so
			// the one-shots must survive for the retry.
			await this.spendOneShotSteering(state.chat.id);

			// Fire the memory sidecar in background (don't await).
			this.triggerMemoryMaintenance(state.chat.id);
		} catch (error) {
			// A stop the server never answered: nothing streamed back, so the stored turn
			// stays untouched (the kept-tail case resolves normally above).
			if (!(error instanceof Error && error.name === 'AbortError')) {
				toastStore.failed('continue the reply', error);
			}
		} finally {
			chatStore.endStream();
			this.abortController = null;
			this.isProcessing = false;
		}
	}

	/**
	 * Write an opening scene as a new ROOT sibling: a beginning beside the ones the chat
	 * already holds, never a replacement for them. A card's greetings are root siblings and
	 * multiple roots are legal, so an opening is one more of the same kind and every surface
	 * that walks the tree handles it without being told.
	 *
	 * `direction` is what the reader typed. Blank means "surprise me"; there is no magic
	 * string for that, because a sentinel the caller has to spell is a second contract.
	 */
	async generateOpeningScene(direction: string): Promise<void> {
		if (this.isProcessing) return;
		// The Opening Scene engine can be switched off app-wide (Settings → Engines). Every
		// trigger hides or refuses when it's off; fail loud if something calls in anyway.
		if (!featurePromptsStore.openingSceneEnabled) throw new Error('Opening Scene is turned off in Settings → Engines');
		this.isProcessing = true;

		const state = chatStore.currentChatState;
		if (!state) {
			this.isProcessing = false;
			throw new Error('No active chat');
		}

		this.abortController = new AbortController();
		chatStore.startStream(state.chat.id, { openingScene: true });

		try {
			const chat = await db.getChat(state.chat.id);
			if (!chat) throw new Error('Chat not found');

			// Create a virtual user message for {{chatHistory}} to inject (not saved to DB)
			const sceneIdea = direction.trim() || 'Surprise me with a compelling opening scene.';
			const openingSceneTemplate = featurePromptsStore.promptFor('openingScene');
			// Global engine macros first, then the flow's own {{idea}} key, a call-site
			// substitution deliberately not a macros.ts entry. It is NOT {{scenario}}:
			// that macro belongs to the character card's scenario field, which resolves
			// normally here alongside this direction.
			const openingSceneDirection = substitute(openingSceneTemplate, {
				...resolveMacroValues(openingSceneTemplate, buildLiveMacroContext({ memory: memoryStore.recall })),
				idea: sceneIdea
			});

			const virtualUserMessage: Message = {
				id: 'virtual-opening-scene',
				chatId: state.chat.id,
				parentId: null,
				role: 'user',
				content: openingSceneDirection,
				personaId: null,
				branchLabel: null,
				thinking: null,
				attachments: null,
				createdAt: Date.now(),
				editedAt: null,
			minorEditedAt: null,
			spriteLabel: null,
				model: null,
				provider: null,
				tokensPrompt: null,
				tokensCompletion: null,
				finishReason: null,
				generationMs: null,
				firstTokenMs: null,
				reasoningMs: null,
				lorebook: null,
				siblingIndex: 0
			};

			// Same steering flush as generateResponse: the prompt builder reads the db rows.
			await steeringStore.flush();
			// Build prompt with the virtual user message as the entire chat path, so
			// {{chatHistory}} injects the direction as the one user turn. Rides the engine
			// target: Opening Scene resolves to its own assignment on the Connections page,
			// and assembly must follow the serving connection.
			const { messages, lorebook, oneShotSteering } = await buildPromptMessages({
				chatId: chat.id,
				chatMessages: [virtualUserMessage],
				target: { engine: 'opening-scene' }
			});

			// Written by the SERVER when the model stops, like any reply. A root sibling,
			// appended after whatever roots are already there, with the sibling index and the
			// root claim both resolved against fresh rows inside the commit's own transaction
			// rather than read here and used a paragraph later. No user turn is saved: the
			// direction was context, not something the reader said in the story.
			const result = await llmService.complete({ engine: 'opening-scene' }, {
				messages,
				source: 'opening-scene',
				onToken: (token) => {
					chatStore.appendStreamingContent(token);
				},
				onThinkingToken: (token) => {
					chatStore.appendStreamingThinking(token);
				},
				signal: this.abortController.signal,
				commit: {
					chatId: state.chat.id,
					parentId: null,
					// The reader asked for this beginning, so it is the one they land on, unless
					// they moved on while it was being written. Off the fresh row rather than the
					// store's snapshot: this is a claim about where the chat stands right now.
					expectedLeafId: chat.activeLeafId,
					claimsRoot: true,
					lorebook,
					spendSteeringIds: oneShotSteering.map((note) => note.id)
				}
			});

			// Same stop contract as generateResponse: keep what streamed, and treat a stop
			// before the first token as a plain abort (nothing to persist).
			if (!result.committedMessageId) return;

			// Teach the per-model token calibration from the provider's real prompt_tokens.
			tokenCalibration.record(result.model, countMessages(messages, result.model), result.usage.promptTokens);

			await chatStore.refreshChat(state.chat.id);

			// Steering rode this opening scene too: the notes were spent inside the commit,
			// and this is the reuse list they leave behind.
			await chatStore.pushSteeringHistory(state.chat.id, oneShotSteering.map((note) => note.text));

			// Fire the memory sidecar in background (don't await).
			this.triggerMemoryMaintenance(state.chat.id);
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				// User cancelled
			} else if (error instanceof Error) {
				// Same re-read as generateResponse: the scene is the server's to write, so a
				// break here does not mean none landed.
				await chatStore.refreshChat(state.chat.id);
				toastStore.failed('generate the opening scene', error);
			}
		} finally {
			chatStore.endStream();
			this.abortController = null;
			this.isProcessing = false;
		}
	}

	/**
	 * Add one turn to the end of the visible path and generate nothing.
	 *
	 * The composer's two Insert rows pass no content and leave an empty turn to type into;
	 * `/say` passes the line the user already typed. Same insert either way, which is what
	 * keeps "a turn that asks for no reply" a single recipe.
	 */
	async insertDummyMessage(role: 'user' | 'assistant', content = ''): Promise<void> {
		if (this.warnIfBusy()) return;
		const state = chatStore.currentChatState;
		if (!state) throw new Error('No active chat');

		const dummyMessage = await this.createMessage({
			chatId: state.chat.id,
			parentId: state.chat.activeLeafId,
			role,
			content,
			siblingIndex: await db.getNextSiblingIndex(state.chat.id, state.chat.activeLeafId)
		});

		if (!state.chat.rootMessageId) {
			await db.updateChat(
				{
					id: state.chat.id,
					rootMessageId: dummyMessage.id,
					activeLeafId: dummyMessage.id
				},
				{ touchUpdatedAt: true }
			);
		} else {
			await db.updateChatActiveLeaf(state.chat.id, dummyMessage.id, { touchUpdatedAt: true });
		}

		await chatStore.refreshCurrentChat();
	}

	/**
	 * Fire-and-forget chat-memory upkeep after a turn: extract any newly-eligible batches and
	 * promote, both capped per turn. Nothing is rolled back: the archive boundary is derived
	 * from the episodes' own coverage, so a path change re-answers it without a write. No-op
	 * when memory is off for this chat. Never blocks generation.
	 */
	private triggerMemoryMaintenance(chatId: string): void {
		const state = chatStore.currentChatState;
		if (!state || state.chat.id !== chatId) return;
		memoryStore.maintainAfterTurn({
			chatId,
			allMessages: state.allMessages,
			leafId: state.chat.activeLeafId,
			characterId: state.chat.characterId,
			characterVersionId: state.chat.characterVersionId
		});
	}

	private async createMessage(
		data: Partial<Message> & {
			chatId: string;
			role: 'user' | 'assistant' | 'system';
			content: string;
		}
	): Promise<Message> {
		const message: Message = {
			id: crypto.randomUUID(),
			chatId: data.chatId,
			parentId: data.parentId ?? null,
			role: data.role,
			content: data.content,
			// Lock the persona this message belongs to. New user messages capture the
			// currently active persona; branches/clones pass the source message's personaId
			// to inherit it. Assistant/system messages never carry a persona.
			personaId:
				data.role === 'user'
					? data.personaId !== undefined
						? data.personaId
						: personaStore.activeId
					: null,
			branchLabel: data.branchLabel ?? null,
			thinking: data.thinking ?? null,
			attachments: data.attachments?.length ? data.attachments : null,
			createdAt: Date.now(),
			editedAt: null,
			minorEditedAt: null,
			// Always unread at birth: the Sprites engine reads a turn once it exists,
			// never as part of writing it.
			spriteLabel: null,
			model: data.model ?? null,
			provider: data.provider ?? null,
			tokensPrompt: data.tokensPrompt ?? null,
			tokensCompletion: data.tokensCompletion ?? null,
			finishReason: data.finishReason ?? null,
			generationMs: data.generationMs ?? null,
			firstTokenMs: data.firstTokenMs ?? null,
			reasoningMs: data.reasoningMs ?? null,
			// Only a generation carries one. Every other door into this method (inserted turns,
			// seeded greetings, branches, clones) leaves it null, which is the honest answer:
			// no scan ran for that row.
			lorebook: data.lorebook ?? null,
			siblingIndex: data.siblingIndex ?? 0
		};

		await db.insertMessage(message);
		// Keep the chat→persona index in step with the persona this message just locked
		// in, so the welcome/chat lists show whose persona the chat belongs to.
		if (message.role === 'user') chatCastStore.setPersonaForChat(message.chatId, message.personaId);
		return message;
	}

	/**
	 * Spend the one-shot steering notes that rode a generation, and record their texts in
	 * the chat's reuse history. Called ONLY after a persisted success, never on an abort,
	 * an error, or continue's no-new-content soft return, so a failed steered turn keeps
	 * its guidance armed for the retry.
	 */
	private async spendOneShotSteering(chatId: string): Promise<void> {
		if (!featurePromptsStore.steeringEnabled) return;
		const chat = chatStore.chats.find((c) => c.id === chatId);
		if (!chat) throw new Error(`spendOneShotSteering: chat ${chatId} is not loaded`);
		const spent = await steeringStore.consumeOnce(steeringTargetForChat(chat));
		await chatStore.pushSteeringHistory(chatId, spent);
	}

	private async buildMessageHistory(
		chatId: string,
		leafId: string,
		lorebookTrigger: LorebookTrigger
	): Promise<BuiltPrompt> {
		const messages = await db.getMessagesByChat(chatId);
		const path = findActivePath(messages, leafId);

		// Build prompt messages with macro expansion. The chat's character/persona
		// looked up by chat id.
		// Chat history reaches the prompt through the {{chatHistory}} macro in the preset
		return buildPromptMessages({
			chatId,
			chatMessages: path,
			lorebookTrigger
		});
	}
}

export const messageStore = new MessageStore();
