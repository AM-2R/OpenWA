import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, IsInt, IsNumber, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MessageDirection } from '../../message/entities/message.entity';
import type { MessageType } from '../../../engine/interfaces/whatsapp-engine.interface';
import { ToStrictNumber, ToStrictString } from '../../../common/utils/strict-boolean';
import { SEARCH_OFFSET_MAX, SEARCH_QUERY_MAX_LENGTH, SEARCH_TERMS_MAX } from '../search.constants';

/**
 * Request shape for GET /search. Numeric fields are coerced from query-string strings via
 * `@Type(() => Number)` and then validated, so `?limit=abc` (Number('abc') → NaN) surfaces as a 400
 * from the global ValidationPipe, never reaching the provider as a NaN SQL param. The epoch-ms
 * bounds `dateFrom`/`dateTo` use `@IsNumber()` within the safe integer range: beyond it a number is no longer an
 * exact integer and no timestamp reaches it, and the cap is the DTO's own, so it holds on both databases (a
 * bigint column only overflows far above it, on PostgreSQL); `limit`/`offset` use `@IsInt()`, because they are
 * bound straight into `LIMIT ?`/`OFFSET ?` where better-sqlite3 rejects a fractional value with
 * SQLITE_MISMATCH: a fraction has to be a 400 here rather than a driver-level 500. `sessionIds` and
 * `chatIds` are intentionally absent: both scopes are injected by SearchService from the caller's
 * API-key allowedSessions/allowedChats (never user-supplied).
 */
export class SearchQueryDto {
  @ApiProperty({
    description: `Search term (required, non-empty, at most ${SEARCH_QUERY_MAX_LENGTH} characters and ${SEARCH_TERMS_MAX} words)`,
    maxLength: SEARCH_QUERY_MAX_LENGTH,
  })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(SEARCH_QUERY_MAX_LENGTH)
  q!: string;

  @ApiPropertyOptional({ description: 'Restrict to a single session' })
  @IsOptional()
  @ToStrictString()
  @IsString()
  sessionId?: string;

  @ApiPropertyOptional({
    description:
      "Restrict to a single chat id. With the built-in search provider, a phone also matches the chat's other stored forms (the other user dialect and any lid that resolves to it); a plugin provider receives the id as sent.",
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  chatId?: string;

  @ApiPropertyOptional({
    description:
      "Sender filter. With the built-in search provider, matches `from` or a group message's `author`, and a phone also matches any lid that resolves to it; a plugin provider receives the id as sent.",
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ enum: MessageDirection, description: 'incoming | outgoing' })
  @IsOptional()
  @IsEnum(MessageDirection)
  direction?: MessageDirection;

  @ApiPropertyOptional({ description: 'Message type filter (compared against stored messages.type)' })
  @IsOptional()
  @IsString()
  // `MessageType` is a string-literal union type alias, not a runtime enum, so @IsEnum can't validate
  // it. @IsString() accepts any string; the provider matches it against stored messages.type values.
  type?: MessageType;

  @ApiPropertyOptional({
    description: 'Epoch-ms lower bound (inclusive)',
    type: Number,
    minimum: -Number.MAX_SAFE_INTEGER,
    maximum: Number.MAX_SAFE_INTEGER,
  })
  @ToStrictNumber()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-Number.MAX_SAFE_INTEGER)
  @Max(Number.MAX_SAFE_INTEGER)
  dateFrom?: number;

  @ApiPropertyOptional({
    description: 'Epoch-ms upper bound (inclusive)',
    type: Number,
    minimum: -Number.MAX_SAFE_INTEGER,
    maximum: Number.MAX_SAFE_INTEGER,
  })
  @ToStrictNumber()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-Number.MAX_SAFE_INTEGER)
  @Max(Number.MAX_SAFE_INTEGER)
  dateTo?: number;

  @ApiPropertyOptional({ description: 'Max hits to return', type: 'integer', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({
    description: `Pagination offset, at most ${SEARCH_OFFSET_MAX}`,
    type: 'integer',
    minimum: 0,
    maximum: SEARCH_OFFSET_MAX,
  })
  @IsOptional()
  @ToStrictNumber()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  // Rejected rather than clamped: a clamped offset silently returns the page at the cap again.
  @Max(SEARCH_OFFSET_MAX)
  offset?: number;
}
