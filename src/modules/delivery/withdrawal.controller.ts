import { Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Actor } from '../../common/auth.util';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { WithdrawalStatus } from './entities/withdrawal.schema';
import { WithdrawalService } from './withdrawal.service';

/** Thin HTTP layer for courier payout requests. */
@ApiTags('withdrawals')
@ApiBearerAuth()
@Controller('api/courier-profile')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WithdrawalController {
  constructor(private readonly withdrawals: WithdrawalService) {}

  @Post('withdrawals')
  @Roles('livreur')
  @ApiOperation({ summary: 'Withdraw the whole available balance (creates a PENDING request)' })
  request(@CurrentActor() actor: Actor) {
    return this.withdrawals.request(actor);
  }

  @Get('earnings')
  @Roles('livreur')
  @ApiOperation({ summary: "Connected courier's balance: delivered trips minus requested payouts" })
  earnings(@CurrentActor() actor: Actor) {
    return this.withdrawals.earnings(actor);
  }

  @Get('withdrawals')
  @Roles('livreur')
  @ApiOperation({ summary: "Connected courier's withdrawal requests" })
  list(@CurrentActor() actor: Actor) {
    return this.withdrawals.list(actor);
  }

  @Get('admin/withdrawals')
  @Roles('admin')
  @ApiOperation({ summary: 'Back-office: withdrawal requests by status (default PENDING), with full IBAN' })
  adminList(@CurrentActor() actor: Actor, @Query('status') status?: string) {
    const parsed = status?.toUpperCase() === WithdrawalStatus.Paid ? WithdrawalStatus.Paid : WithdrawalStatus.Pending;
    return this.withdrawals.adminList(actor, parsed);
  }

  @Patch('admin/withdrawals/:id/paid')
  @Roles('admin')
  @ApiOperation({ summary: 'Back-office: mark a withdrawal as paid once the transfer is made' })
  markPaid(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.withdrawals.markPaid(actor, id);
  }
}
