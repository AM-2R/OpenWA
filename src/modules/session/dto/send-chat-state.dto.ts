import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { ChatState } from '../../../engine/interfaces/whatsapp-engine.interface';
import { CHAT_ID_MAX_LENGTH } from '../../message/dto/send-message.dto';
import { ToStrictString } from '../../../common/utils/strict-boolean';

export class SendChatStateDto {
  @ApiProperty({
    maxLength: CHAT_ID_MAX_LENGTH,
    // Engine-neutral on purpose: the chat id is whatever the active engine uses
    // (e.g. <number>@c.us on whatsapp-web.js, <number>@s.whatsapp.net on Baileys).
    // The adapter validates/normalises it — we only require a non-empty string here.
    description: "Chat ID, in the active engine's native format (e.g. 1234567890@c.us)",
    example: '1234567890@c.us',
  })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CHAT_ID_MAX_LENGTH)
  chatId!: string;

  @ApiProperty({
    description: "Presence to send: 'typing' or 'recording' shows the indicator; 'paused' clears it",
    enum: ['typing', 'recording', 'paused'],
    example: 'typing',
  })
  @IsIn(['typing', 'recording', 'paused'])
  state!: ChatState;
}
