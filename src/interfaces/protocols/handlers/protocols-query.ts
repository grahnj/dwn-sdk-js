import type { MethodHandler } from '../../types';
import type { ProtocolsQueryMessage } from '../types';
import { canonicalAuth } from '../../../core/auth';
import { MessageReply } from '../../../core';
import { removeUndefinedProperties } from '../../../utils/object';

export const handleProtocolsQuery: MethodHandler = async (
  message,
  messageStore,
  didResolver
): Promise<MessageReply> => {
  const incomingMessage = message as ProtocolsQueryMessage;

  try {
    await canonicalAuth(incomingMessage, didResolver, messageStore);
  } catch (e) {
    return new MessageReply({
      status: { code: 401, detail: e.message }
    });
  }

  try {
    const query = {
      target : incomingMessage.descriptor.target,
      method : 'ProtocolsConfigure',
      ...incomingMessage.descriptor.filter
    };
    removeUndefinedProperties(query);

    const entries = await messageStore.query(query);

    return new MessageReply({
      status: { code: 200, detail: 'OK' },
      entries
    });
  } catch (e) {
    return new MessageReply({
      status: { code: 500, detail: e.message }
    });
  }
};
