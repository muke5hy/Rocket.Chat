import moment from 'moment-timezone';
import type { ILivechatBusinessHour } from '@rocket.chat/core-typings';
import { LivechatBusinessHourTypes } from '@rocket.chat/core-typings';
import { LivechatBusinessHours, LivechatDepartment, LivechatDepartmentAgents, Users } from '@rocket.chat/models';

import { isEnterprise } from '../../../license/server/license';
import { businessHourLogger } from '../../../../../app/livechat/server/lib/logger';

const getAllAgentIdsWithoutDepartment = async (): Promise<string[]> => {
	const agentIdsWithDepartment = (
		await LivechatDepartmentAgents.find({ departmentEnabled: true }, { projection: { agentId: 1 } }).toArray()
	).map((dept) => dept.agentId);

	const agentIdsWithoutDepartment = (
		await Users.findUsersInRolesWithQuery(
			'livechat-agent',
			{
				_id: { $nin: agentIdsWithDepartment },
			},
			{ projection: { _id: 1 } },
		).toArray()
	).map((user) => user._id);

	return agentIdsWithoutDepartment;
};

const getAllAgentIdsWithDepartmentNotConnectedToBusinessHour = async (): Promise<string[]> => {
	const activeDepartmentsWithoutBusinessHour = (
		await LivechatDepartment.findActiveDepartmentsWithoutBusinessHour({
			projection: { _id: 1 },
		}).toArray()
	).map((dept) => dept._id);

	const agentIdsWithDepartmentNotConnectedToBusinessHour = await LivechatDepartmentAgents.findAllAgentsConnectedToListOfDepartments(
		activeDepartmentsWithoutBusinessHour,
	);
	return agentIdsWithDepartmentNotConnectedToBusinessHour;
};

const getAllAgentIdsForDefaultBusinessHour = async (): Promise<string[]> => {
	const [withoutDepartment, withDepartmentNotConnectedToBusinessHour] = await Promise.all([
		getAllAgentIdsWithoutDepartment(),
		getAllAgentIdsWithDepartmentNotConnectedToBusinessHour(),
	]);

	return [...new Set([...withoutDepartment, ...withDepartmentNotConnectedToBusinessHour])];
};

const getAgentIdsToHandle = async (businessHour: Pick<ILivechatBusinessHour, '_id' | 'type'>): Promise<string[]> => {
	if (businessHour.type === LivechatBusinessHourTypes.DEFAULT) {
		return getAllAgentIdsForDefaultBusinessHour();
	}
	const departmentIds = (
		await LivechatDepartment.findEnabledByBusinessHourId(businessHour._id, {
			projection: { _id: 1 },
		}).toArray()
	).map((dept) => dept._id);
	return (
		await LivechatDepartmentAgents.findByDepartmentIds(departmentIds, {
			projection: { agentId: 1 },
		}).toArray()
	).map((dept) => dept.agentId);
};

export const openBusinessHour = async (businessHour: Pick<ILivechatBusinessHour, '_id' | 'type'>): Promise<void> => {
	const agentIds = await getAgentIdsToHandle(businessHour);
	businessHourLogger.debug({
		msg: 'Opening business hour',
		businessHour: businessHour._id,
		totalAgents: agentIds.length,
		top10AgentIds: agentIds.slice(0, 10),
	});

	await Users.addBusinessHourByAgentIds(agentIds, businessHour._id);
	await Users.updateLivechatStatusBasedOnBusinessHours();
};

export const closeBusinessHour = async (businessHour: Pick<ILivechatBusinessHour, '_id' | 'type'>): Promise<void> => {
	const agentIds: string[] = await getAgentIdsToHandle(businessHour);
	businessHourLogger.debug({
		msg: 'Closing business hour',
		businessHour: businessHour._id,
		totalAgents: agentIds.length,
		top10AgentIds: agentIds.slice(0, 10),
	});
	await Users.removeBusinessHourByAgentIds(agentIds, businessHour._id);
	await Users.updateLivechatStatusBasedOnBusinessHours();
};

export const removeBusinessHourByAgentIds = async (agentIds: string[], businessHourId: string): Promise<void> => {
	if (!agentIds.length) {
		return;
	}
	await Users.removeBusinessHourByAgentIds(agentIds, businessHourId);
	await Users.updateLivechatStatusBasedOnBusinessHours();
};

export const resetDefaultBusinessHourIfNeeded = async (): Promise<void> => {
	if (isEnterprise()) {
		return;
	}

	const defaultBusinessHour = await LivechatBusinessHours.findOneDefaultBusinessHour<Pick<ILivechatBusinessHour, '_id'>>({
		projection: { _id: 1 },
	});
	if (!defaultBusinessHour) {
		return;
	}

	await LivechatBusinessHours.updateOne(
		{ _id: defaultBusinessHour._id },
		{
			$set: {
				timezone: {
					name: moment.tz.guess(),
					utc: String(moment().utcOffset() / 60),
				},
			},
		},
	);
};
