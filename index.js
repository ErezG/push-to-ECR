const CORE = require('@actions/core');
const YAML = require('yaml');
const fs = require('fs');
const { exec } = require("child_process");
const { ECRClient, BatchDeleteImageCommand } = require("@aws-sdk/client-ecr");

// inputs
const env_key = CORE.getInput('env-key');
var local_image = CORE.getInput('local-image');
const remote_image = CORE.getInput('remote-image');
const extra_tags = readExtraTags();

//global vars
const ActionTriggersEnum = Object.freeze({"build":1, "retag":2});
var actionTrigger = ActionTriggersEnum.build;

function readExtraTags() {
	var input = CORE.getInput('extra-tags');
	var obj = {};
	if (input) {
		var KVPs = input.split(',');
		KVPs.forEach(function(kvp) {
			var parts = kvp.split('=');
			if (parts.length != 2) {
				throw 'malformed input: extra-tags.'
			}
			const key = parts[0];
			const value = parts[1];
			if (key in obj) {
				throw `extra-tags has duplicate key: ${key}.`
			}
			obj[key] = value;
		});
	}
	return obj;
}

async function pushToECR(target) {
  try {
	
	var registry = target['ecr-registry'];
	var repository = target['ecr-repository'];
	var tag = target['ecr-tag'];
	var forcePush = target['force-push'];
	var continueOnError = target['continue-on-error'];
	var onlyOnBuild = target['only-on-build'];
	var error = false;
	
	if (!registry) {
		CORE.setFailed(`ECR push target is missing ecr-registry`);
		error = true;
	}
	if (!repository) {
		CORE.setFailed(`ECR push target is missing ecr-repository`);
		error = true;
	}
	if (!tag) {
		CORE.setFailed(`ECR push target is missing ecr-tag`);
		error = true;
	}
	if (tag.startsWith('$$')) {
		var input_tag = extra_tags[tag.substring(2)];
		if (input_tag) {
			tag = input_tag;
		}
		else {
			CORE.setFailed(`ECR push target is missing ecr-tag. extra-tags is missing tag ${tag.substring(2)}.`);
			error = true;
		}
	}
	if (forcePush !== undefined && forcePush !== true && forcePush !== false) {
		CORE.setFailed(`ECR push target has invalid value for force-push. Either omit this property or set it to one of the valid values: [true, false]`);
		error = true;
	}
	if (continueOnError !== undefined && continueOnError !== true && continueOnError !== false) {
		CORE.setFailed(`ECR push target has invalid value for continue-on-error. Either omit this property or set it to one of the valid values: [true, false]`);
		error = true;
	}
	if (actionTrigger !== ActionTriggersEnum.build && onlyOnBuild !== undefined && onlyOnBuild !== true && onlyOnBuild !== false) {
		CORE.setFailed(`ECR push target has invalid value for only-on-build. Either omit this property or set it to one of the valid values: [true, false]`);
		error = true;
	}
	if (error) { return; }
	
	var newImage = `${registry}/${repository}:${tag}`;
	
	if (onlyOnBuild && actionTrigger !== ActionTriggersEnum.build) {
		console.log(`skip ECR push target ${newImage}: tag is set to only-on-build`);
		return;
	}
	
	try {
		var shellResult = await execAsync(`docker image tag ${local_image} ${newImage}`);
		console.log(`tag ${newImage}: success`);
	}
	catch (error) {
		errorMessage = `tag ${newImage}: ${error}`;
		if (continueOnError) { console.error(errorMessage); }
		else { CORE.setFailed(errorMessage); }
		return;
	}
	
	if (forcePush) {
		var ecr_client = new ECRClient();
		const ecr_response = await ecr_client.send(new BatchDeleteImageCommand({
			repositoryName: repository,
			imageIds: [{ imageTag: tag }]
		}));
		if (ecr_response && ecr_response.failures && ecr_response.failures.length > 0) {
			var error = false;
			ecr_response.failures.forEach(function(failure) {
				if (failure.failureCode != 'ImageNotFound') {
					error = true;
				}
			});
			if (error) {
				CORE.setFailed(`delete existing ECR tag ${newImage}: ${JSON.stringify(ecr_response, null, 2)}`);
				return;
			}
		}
		console.log(`ECR delete tag ${newImage} - Success`);
		//console.log(ecr_response);
	}
	
	try {
		var shellResult = await execAsync(`docker image push ${newImage}`);
		console.log(`push ${newImage}: success`);
	}
	catch (error) {
		errorMessage = `push ${newImage}: ${error}`;
		if (continueOnError) { console.error(errorMessage); }
		else { CORE.setFailed(errorMessage); }
		return;
	}
  }
  catch (error) {
    CORE.setFailed(error);
  }
}

function execAsync(command) {
    return new Promise((resolve, reject) => {	
		exec(command, (error, stdout, stderr) => {
			var errorMessage;
			if (error) { reject(error); }
			else if (stderr) { reject(stderr); }
			else { resolve(stdout); }
		});
    });
}

async function main() {
  try {
	
    //console.log(`env_key ${env_key}, spot_io_token ${spot_io_token}`);
	
	if (local_image && remote_image) {
		CORE.setFailed("this action requires only 1 of the following inputs: local-image, remote-image");
		return;
	}
	
	if (!local_image && !remote_image) {
		CORE.setFailed("this action requires 1 of the following inputs: local-image, remote-image");
		return;
	}
	
	if (remote_image) {
		actionTrigger = ActionTriggersEnum.retag;
		local_image = "docker_image:temp";
		
		try { await execAsync(`docker image pull ${remote_image}`); }
		catch { CORE.setFailed(`failed to pull docker image: ${remote_image}`); return; }
		console.log(`pulled remote image ${remote_image}: success`);
		
		try { await execAsync(`docker image tag ${remote_image} ${local_image}`); }
		catch (error) { CORE.setFailed(`tag ${local_image}: ${error}`); return; }
	}
	
	const file = fs.readFileSync('.automation/deployment_envs.yaml', 'utf8');
	var yamlObj = YAML.parse(file);
	var envs = yamlObj['envs'];
	var requested_env = envs[env_key];
	if (!requested_env) {
		CORE.setFailed(`requested env (${env_key}) is missing`);
		return;
	}
	
	var publishTargets = requested_env['publish-to'];
	if (publishTargets && publishTargets.length > 0) {
		console.log(`${env_key} has ${publishTargets.length} ECR publish targets`);
		publishTargets.forEach(pushToECR);
	}
  }
  catch (error) {
    CORE.setFailed(error.message);
  }
}

main();