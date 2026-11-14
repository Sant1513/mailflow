-- Cheap cross-mailbox duplicate check on inbound messages (additive).
CREATE INDEX IF NOT EXISTS "ConversationMessage_messageIdHeader_idx" ON "ConversationMessage"("messageIdHeader");
